// Author: Liz
use std::path::{Path, PathBuf};

use tokio::fs;

use crate::{
    error::{AppError, AppResult},
    models::sftp::{FileEntry, FileKind, LocalPathInfo, TransferKind},
    validation::required_text,
};

pub fn classify_local_paths(paths: Vec<String>) -> AppResult<Vec<LocalPathInfo>> {
    if paths.is_empty() {
        return Err(AppError::validation("请至少选择一个本地路径"));
    }
    paths
        .into_iter()
        .map(|path| {
            let path = required_path(&path)?;
            let metadata = std::fs::metadata(&path)?;
            let kind = if metadata.is_file() {
                TransferKind::File
            } else if metadata.is_dir() {
                TransferKind::Directory
            } else {
                return Err(AppError::validation(format!(
                    "暂不支持该本地路径类型: {path}"
                )));
            };
            Ok(LocalPathInfo { path, kind })
        })
        .collect()
}

pub async fn local_path_total_bytes(path: &str) -> AppResult<u64> {
    let path = PathBuf::from(required_path(path)?);
    let metadata = fs::metadata(&path).await?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total = 0_u64;
    let mut stack = vec![path];
    while let Some(dir) = stack.pop() {
        let mut entries = fs::read_dir(dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let metadata = entry.metadata().await?;
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

pub fn default_local_directory() -> AppResult<String> {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| AppError::validation("无法解析默认本地目录"))
}

pub fn local_root_directories() -> AppResult<Vec<String>> {
    #[cfg(windows)]
    {
        let roots = (b'A'..=b'Z')
            .map(char::from)
            .map(|letter| format!("{letter}:\\"))
            .filter(|root| Path::new(root).is_dir())
            .collect();
        Ok(roots)
    }

    #[cfg(not(windows))]
    {
        Ok(vec!["/".to_string()])
    }
}

pub async fn list_local_directory(path: &str) -> AppResult<Vec<FileEntry>> {
    let path = if path.trim().is_empty() {
        default_local_directory()?
    } else {
        required_path(path)?
    };
    let mut entries = fs::read_dir(PathBuf::from(&path)).await?;
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        let symlink_metadata = fs::symlink_metadata(entry.path()).await.ok();
        let file_type = symlink_metadata
            .as_ref()
            .map(|metadata| metadata.file_type())
            .unwrap_or_else(|| metadata.file_type());
        let modified_at_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok());
        result.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            kind: local_file_kind(file_type),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified_at_ms,
            permissions: None,
        });
    }
    result.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(result)
}

pub async fn rename_local_path(from: &str, to: &str) -> AppResult<()> {
    let from = validate_destructive_local_path(from)?;
    let to = validate_destructive_local_path(to)?;
    if from.parent() != to.parent() {
        return Err(AppError::validation("重命名后的路径必须位于原目录"));
    }
    fs::rename(from, to).await?;
    Ok(())
}

pub async fn delete_local_path(path: &str, recursive: bool) -> AppResult<()> {
    let path = validate_destructive_local_path(path)?;
    let metadata = fs::symlink_metadata(&path).await?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).await?;
    } else if recursive {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_dir(path).await?;
    }
    Ok(())
}

pub(super) fn validate_destructive_local_path(path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(required_path(path)?);
    if !path.is_absolute() {
        return Err(AppError::validation("本机文件操作必须使用绝对路径"));
    }
    if path.parent().is_none() {
        return Err(AppError::validation("不允许对本机根目录执行该操作"));
    }
    Ok(path)
}

fn local_file_kind(file_type: std::fs::FileType) -> FileKind {
    if file_type.is_dir() {
        FileKind::Directory
    } else if file_type.is_file() {
        FileKind::File
    } else if file_type.is_symlink() {
        FileKind::Symlink
    } else {
        FileKind::Other
    }
}

fn required_path(value: &str) -> AppResult<String> {
    required_text("路径", value)
}
