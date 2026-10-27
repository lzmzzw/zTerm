//! Trusted resume for persisted, regular, single-file SFTP transfers only.
#[cfg(test)]
#[path = "transfer_resume_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "transfer_resume_upload_tests.rs"]
mod upload_tests;
use super::*;
use crate::{
    services::transfer_resume::{
        binding, digest_hex, hash_prefix, recoverable_io_error, valid_manifest,
        TransferResumeContext,
    },
    storage::transfer_resume::TransferResumeManifest,
};
use ring::digest::{Context, SHA256};
use tokio::io::{AsyncSeekExt, SeekFrom};

const CHECKPOINT_BYTES: u64 = 4 * 1024 * 1024;

struct DownloadCheckpointWriter<'a> {
    file: &'a mut fs::File,
    context: &'a TransferResumeContext,
    manifest: &'a mut TransferResumeManifest,
    hash: ring::digest::Context,
    offset: u64,
}

impl DownloadCheckpointWriter<'_> {
    fn poll_checkpoint(&mut self, cx: &mut std::task::Context<'_>) -> Poll<io::Result<()>> {
        match Pin::new(&mut *self.file).poll_flush(cx) {
            Poll::Ready(Ok(())) => {
                self.manifest.confirmed_offset = self.offset;
                self.manifest.prefix_sha256 = digest_hex(self.hash.clone());
                Poll::Ready(
                    self.context
                        .save(self.manifest)
                        .map_err(|error| io::Error::other(error.to_string())),
                )
            }
            other => other,
        }
    }
}

impl AsyncWrite for DownloadCheckpointWriter<'_> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.offset.saturating_sub(self.manifest.confirmed_offset) >= CHECKPOINT_BYTES {
            match self.poll_checkpoint(cx) {
                Poll::Ready(Ok(())) => {}
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => return Poll::Pending,
            }
        }
        match Pin::new(&mut *self.file).poll_write(cx, data) {
            Poll::Ready(Ok(written)) => {
                self.hash.update(&data[..written]);
                self.offset += written as u64;
                Poll::Ready(Ok(written))
            }
            other => other,
        }
    }
    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<io::Result<()>> {
        self.poll_checkpoint(cx)
    }
    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<io::Result<()>> {
        self.poll_checkpoint(cx)
    }
}

struct HashWriter {
    hash: Context,
    remaining: u64,
}

impl AsyncWrite for HashWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let used = data.len().min(self.remaining as usize);
        self.hash.update(&data[..used]);
        self.remaining -= used as u64;
        Poll::Ready(Ok(data.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut std::task::Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut std::task::Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

async fn hash_remote(
    source: &mut SftpFile,
    bytes: u64,
    control: Option<&TransferRunControl>,
) -> AppResult<ring::digest::Context> {
    source.seek(SeekFrom::Start(0)).await?;
    let mut hasher = HashWriter {
        hash: ring::digest::Context::new(&SHA256),
        remaining: bytes,
    };
    let activity = Arc::new(Mutex::new(Instant::now()));
    let mut on_progress = |_| Ok(());
    let mut writer = TransferProgressWriter::new(
        &mut hasher,
        0,
        control,
        &mut on_progress,
        Arc::clone(&activity),
    );
    await_transfer_io(
        async {
            source
                .read_to_writer_pipelined(&mut writer, SFTP_MAX_INFLIGHT_REQUESTS)
                .await
                .map_err(sftp_error)
        },
        control,
        activity,
        SFTP_TRANSFER_STALL_TIMEOUT,
    )
    .await?;
    drop(writer);
    if hasher.remaining != 0 {
        return Err(AppError::sftp("续传校验长度不足"));
    }
    source.seek(SeekFrom::Start(bytes)).await?;
    Ok(hasher.hash)
}

fn new_manifest(
    binding: String,
    partial_path: String,
    total_bytes: u64,
    source_sha256: String,
) -> TransferResumeManifest {
    TransferResumeManifest {
        version: 1,
        binding,
        partial_path,
        total_bytes,
        source_sha256,
        confirmed_offset: 0,
        prefix_sha256: digest_hex(Context::new(&SHA256)),
    }
}

fn valid_partial_name(name: &str) -> bool {
    name.strip_prefix(".zterm-")
        .and_then(|value| value.strip_suffix(".partial"))
        .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok())
}

fn owned_remote_partial(partial: &str, target: &str) -> bool {
    remote_parent_path(partial) == remote_parent_path(target)
        && partial.rsplit('/').next().is_some_and(valid_partial_name)
}

fn owned_local_partial(partial: &Path, target: &Path) -> bool {
    partial.parent() == target.parent()
        && partial
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(valid_partial_name)
}

async fn canonical_remote_target(sftp: &RusshSftpSession, path: &str) -> AppResult<String> {
    let parent = remote_parent_path(path).unwrap_or_else(|| ".".to_string());
    let parent = sftp.canonicalize(parent).await.map_err(sftp_error)?;
    let name = path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::validation("文件名不能为空"))?;
    Ok(join_remote_path(&parent, name))
}

fn hash_changed() -> AppError {
    AppError::sftp("源文件内容校验失败，已放弃续传，未发布目标文件")
}

fn load_manifest(context: &TransferResumeContext) -> AppResult<Option<TransferResumeManifest>> {
    match context.load() {
        Ok(manifest) => Ok(manifest),
        Err(error) if outcome_unknown(&error) => Err(error),
        Err(error) => {
            // Corrupt records never grant ownership of a partial path.
            context.clear()?;
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn upload<F>(
    sftp: &RusshSftpSession,
    publisher: &RemotePublisher,
    context: &TransferResumeContext,
    route: &str,
    local_path: &Path,
    remote_path: &str,
    policy: TransferConflictPolicy,
    control: Option<&TransferRunControl>,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    context.ensure_retryable()?;
    transfer_checkpoint(control).await?;
    let path_metadata = fs::symlink_metadata(local_path).await?;
    if !path_metadata.is_file() || path_metadata.file_type().is_symlink() {
        context.clear()?;
        return Err(AppError::sftp("续传来源必须是普通文件，不能是符号链接"));
    }
    let local_path = fs::canonicalize(local_path).await?;
    let mut source = fs::File::open(&local_path).await?;
    let before = source.metadata().await?;
    if let Some(parent) = remote_parent_path(remote_path) {
        create_remote_dir_all(sftp, &parent).await?;
    }
    let target = canonical_remote_target(sftp, remote_path).await?;
    if matches!(policy, TransferConflictPolicy::Skip)
        && sftp.try_exists(&target).await.map_err(sftp_error)?
    {
        context.clear()?;
        on_progress(progress_update(before.len(), Some(before.len())))?;
        return Ok(before.len());
    }
    publisher.check_overwrite(sftp, &target, policy).await?;
    let source_hash = digest_hex(hash_prefix(&mut source, before.len(), control).await?);
    let identity = binding(&[
        "upload",
        route,
        &local_path.to_string_lossy(),
        &target,
        policy.as_str(),
    ]);
    let mut existing = load_manifest(context)?;
    if existing.as_ref().is_some_and(|manifest| {
        !valid_manifest(manifest, &identity, before.len(), &source_hash)
            || !owned_remote_partial(&manifest.partial_path, &target)
    }) {
        // Never delete or adopt an old path after route/path identity changes.
        context.clear()?;
        existing = None;
    }
    let mut adopted = None;
    if let Some(manifest) = existing {
        let metadata = match sftp.symlink_metadata(&manifest.partial_path).await {
            Ok(metadata) => Some(metadata),
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
            {
                None
            }
            Err(error) => return Err(sftp_error(error)),
        };
        if let Some(metadata) = metadata.filter(|metadata| {
            metadata.file_type().is_file()
                && metadata
                    .size
                    .is_some_and(|size| size >= manifest.confirmed_offset)
        }) {
            let _ = metadata;
            let mut partial = sftp
                .open_with_flags(&manifest.partial_path, OpenFlags::READ | OpenFlags::WRITE)
                .await
                .map_err(sftp_error)?;
            let partial_hash =
                digest_hex(hash_remote(&mut partial, manifest.confirmed_offset, control).await?);
            let source_prefix =
                digest_hex(hash_prefix(&mut source, manifest.confirmed_offset, control).await?);
            if partial_hash == manifest.prefix_sha256 && source_prefix == manifest.prefix_sha256 {
                partial
                    .set_metadata(FileAttributes {
                        size: Some(manifest.confirmed_offset),
                        ..FileAttributes::empty()
                    })
                    .await
                    .map_err(sftp_error)?;
                partial
                    .seek(SeekFrom::Start(manifest.confirmed_offset))
                    .await?;
                adopted = Some((manifest, partial));
            }
        }
        if adopted.is_none() {
            context.clear()?;
        }
    }
    let (mut manifest, mut partial) = match adopted {
        Some(value) => value,
        None => {
            let (path, file) = remote_partial(sftp, &target).await?;
            let manifest = new_manifest(identity, path, before.len(), source_hash);
            if let Err(error) = context.save(&manifest) {
                drop(file);
                let _ = sftp.remove_file(&manifest.partial_path).await;
                return Err(error);
            }
            (manifest, file)
        }
    };
    let result = async {
        preserve_remote_overwrite_metadata(sftp, &manifest.partial_path, &target, policy).await?;
        let mut hash = hash_prefix(&mut source, manifest.confirmed_offset, control).await?;
        let mut offset = manifest.confirmed_offset;
        on_progress(progress_update(offset, Some(before.len())))?;
        let mut buffer = vec![0; TRANSFER_BUFFER_SIZE];
        loop {
            transfer_checkpoint(control).await?;
            let read = source.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            await_transfer_io(
                async {
                    partial
                        .write_all(&buffer[..read])
                        .await
                        .map_err(|e| AppError::sftp(e.to_string()))
                },
                control,
                Arc::new(Mutex::new(Instant::now())),
                SFTP_TRANSFER_STALL_TIMEOUT,
            )
            .await?;
            hash.update(&buffer[..read]);
            offset += read as u64;
            if offset - manifest.confirmed_offset >= CHECKPOINT_BYTES {
                // flush drains WRITE acknowledgements before advancing manifest.
                partial
                    .flush()
                    .await
                    .map_err(|e| AppError::sftp(e.to_string()))?;
                manifest.confirmed_offset = offset;
                manifest.prefix_sha256 = digest_hex(hash.clone());
                context.save(&manifest)?;
            }
            on_progress(progress_update(offset, Some(before.len())))?;
        }
        if offset != before.len() || digest_hex(hash) != manifest.source_sha256 {
            return Err(hash_changed());
        }
        let mut current_source = fs::File::open(&local_path).await?;
        if digest_hex(hash_prefix(&mut current_source, before.len(), control).await?)
            != manifest.source_sha256
        {
            return Err(hash_changed());
        }
        validate_local_source(&before, &source.metadata().await?, offset)?;
        validate_local_source(&before, &fs::metadata(&local_path).await?, offset)?;
        finish_remote_partial(&mut partial, offset, control).await?;
        preserve_remote_overwrite_metadata(sftp, &manifest.partial_path, &target, policy).await?;
        transfer_checkpoint(control).await?;
        let _publish_guard = control.map(TransferRunControl::begin_publish).transpose()?;
        context.mark_publishing()?;
        publisher
            .publish(sftp, &manifest.partial_path, &target, policy)
            .await?;
        // After successful publication a storage error must keep publishing,
        // never report an ordinary retryable error.
        context.clear().map_err(|_| {
            AppError::sftp(format!(
                "{SFTP_PUBLISH_OUTCOME_UNKNOWN}: 文件已发布，完成记录未确认"
            ))
        })?;
        Ok(offset)
    }
    .await;
    drop(partial);
    if let Err(error) = &result {
        if !outcome_unknown(error)
            && (control.is_some_and(TransferRunControl::is_cancelled)
                || !recoverable_io_error(error))
        {
            let _ = sftp.remove_file(&manifest.partial_path).await;
            context.clear()?;
        }
    }
    result
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn download<F>(
    sftp: &RusshSftpSession,
    context: &TransferResumeContext,
    route: &str,
    remote_path: &str,
    local_path: &Path,
    policy: TransferConflictPolicy,
    control: Option<&TransferRunControl>,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    context.ensure_retryable()?;
    transfer_checkpoint(control).await?;
    let metadata = sftp
        .symlink_metadata(remote_path)
        .await
        .map_err(sftp_error)?;
    if !metadata.file_type().is_file() {
        context.clear()?;
        return Err(AppError::sftp("续传来源必须是普通文件，不能是符号链接"));
    }
    let remote_path = sftp.canonicalize(remote_path).await.map_err(sftp_error)?;
    let mut source = sftp.open(&remote_path).await.map_err(sftp_error)?;
    let before = source.metadata().await.map_err(sftp_error)?;
    let size = before
        .size
        .ok_or_else(|| AppError::sftp("续传来源缺少可信长度"))?;
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let parent = fs::canonicalize(local_path.parent().unwrap_or(Path::new("."))).await?;
    let target = parent.join(
        local_path
            .file_name()
            .ok_or_else(|| AppError::validation("文件名不能为空"))?,
    );
    if matches!(policy, TransferConflictPolicy::Skip) && fs::try_exists(&target).await? {
        context.clear()?;
        on_progress(progress_update(size, Some(size)))?;
        return Ok(size);
    }
    let source_hash = digest_hex(hash_remote(&mut source, size, control).await?);
    let identity = binding(&[
        "download",
        route,
        &remote_path,
        &target.to_string_lossy(),
        policy.as_str(),
    ]);
    let mut existing = load_manifest(context)?;
    if existing.as_ref().is_some_and(|manifest| {
        !valid_manifest(manifest, &identity, size, &source_hash)
            || !owned_local_partial(Path::new(&manifest.partial_path), &target)
    }) {
        context.clear()?;
        existing = None;
    }
    let mut adopted = None;
    if let Some(manifest) = existing {
        let path = Path::new(&manifest.partial_path);
        let metadata = match fs::symlink_metadata(path).await {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        if metadata.is_some_and(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() >= manifest.confirmed_offset
        }) {
            let mut partial = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .await?;
            let partial_hash =
                digest_hex(hash_prefix(&mut partial, manifest.confirmed_offset, control).await?);
            let source_prefix =
                digest_hex(hash_remote(&mut source, manifest.confirmed_offset, control).await?);
            if partial_hash == manifest.prefix_sha256 && source_prefix == manifest.prefix_sha256 {
                partial.set_len(manifest.confirmed_offset).await?;
                partial
                    .seek(SeekFrom::Start(manifest.confirmed_offset))
                    .await?;
                adopted = Some((manifest, partial));
            }
        }
        if adopted.is_none() {
            context.clear()?;
        }
    }
    let (mut manifest, mut partial) = match adopted {
        Some(value) => value,
        None => {
            let (path, file) = local_partial(&target).await?;
            let manifest = new_manifest(
                identity,
                path.to_string_lossy().into_owned(),
                size,
                source_hash,
            );
            if let Err(error) = context.save(&manifest) {
                drop(file);
                let _ = fs::remove_file(&path).await;
                return Err(error);
            }
            (manifest, file)
        }
    };
    let result = async {
        source
            .seek(SeekFrom::Start(manifest.confirmed_offset))
            .await?;
        on_progress(progress_update(manifest.confirmed_offset, Some(size)))?;
        let last_activity = Arc::new(Mutex::new(Instant::now()));
        let initial_offset = manifest.confirmed_offset;
        let initial_hash = hash_prefix(&mut partial, initial_offset, control).await?;
        let mut checkpoint_writer = DownloadCheckpointWriter {
            file: &mut partial,
            context,
            manifest: &mut manifest,
            hash: initial_hash,
            offset: initial_offset,
        };
        let mut writer = TransferProgressWriter::new(
            &mut checkpoint_writer,
            initial_offset,
            control,
            on_progress,
            Arc::clone(&last_activity),
        );
        let transfer = await_transfer_io(
            async {
                source
                    .read_to_writer_pipelined(&mut writer, SFTP_MAX_INFLIGHT_REQUESTS)
                    .await
                    .map_err(sftp_error)
            },
            control,
            last_activity,
            SFTP_TRANSFER_STALL_TIMEOUT,
        )
        .await;
        let offset = writer.transferred_bytes();
        drop(writer);
        if let Err(error) = transfer {
            // Only bytes flushed locally can become a recoverable checkpoint.
            if recoverable_io_error(&error)
                && !control.is_some_and(TransferRunControl::is_cancelled)
            {
                partial.flush().await?;
                partial.sync_all().await?;
                if offset <= size && partial.metadata().await?.len() >= offset {
                    manifest.prefix_sha256 =
                        digest_hex(hash_prefix(&mut partial, offset, control).await?);
                    manifest.confirmed_offset = offset;
                    context.save(&manifest)?;
                }
            }
            return Err(error);
        }
        partial.flush().await?;
        partial.sync_all().await?;
        if offset != size
            || digest_hex(hash_prefix(&mut partial, size, control).await?) != manifest.source_sha256
        {
            return Err(hash_changed());
        }
        let mut current_source = sftp.open(&remote_path).await.map_err(sftp_error)?;
        if digest_hex(hash_remote(&mut current_source, size, control).await?)
            != manifest.source_sha256
        {
            return Err(hash_changed());
        }
        validate_remote_source(
            &before,
            &source.metadata().await.map_err(sftp_error)?,
            offset,
        )?;
        validate_remote_source(
            &before,
            &sftp.metadata(&remote_path).await.map_err(sftp_error)?,
            offset,
        )?;
        source
            .shutdown()
            .await
            .map_err(|e| AppError::sftp(e.to_string()))?;
        transfer_checkpoint(control).await?;
        Ok(offset)
    }
    .await;
    drop(partial);
    let result = match result {
        Ok(offset) => {
            async {
                transfer_checkpoint(control).await?;
                let _publish_guard = control.map(TransferRunControl::begin_publish).transpose()?;
                context.mark_publishing()?;
                publish_local(Path::new(&manifest.partial_path), &target, policy).await?;
                context.clear().map_err(|_| {
                    AppError::sftp(format!(
                        "{SFTP_PUBLISH_OUTCOME_UNKNOWN}: 文件已发布，完成记录未确认"
                    ))
                })?;
                Ok(offset)
            }
            .await
        }
        Err(error) => Err(error),
    };
    if let Err(error) = &result {
        if !outcome_unknown(error)
            && (control.is_some_and(TransferRunControl::is_cancelled)
                || !recoverable_io_error(error))
        {
            let _ = fs::remove_file(&manifest.partial_path).await;
            context.clear()?;
        }
    }
    result
}
