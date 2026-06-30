// Author: Liz
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    data_dir: PathBuf,
    db_path: PathBuf,
    logs_dir: PathBuf,
    temp_dir: PathBuf,
    downloads_dir: PathBuf,
}

impl AppPaths {
    pub fn default_for_install() -> AppResult<Self> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| AppError::storage("failed to locate the user data directory"))?
            .join("zTerm");
        Ok(Self::from_data_dir(data_dir))
    }

    pub fn from_data_dir(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        Self {
            db_path: data_dir.join("zterm.db"),
            logs_dir: data_dir.join("logs"),
            temp_dir: data_dir.join("temp"),
            downloads_dir: data_dir.join("downloads"),
            data_dir,
        }
    }

    pub fn ensure_dirs(&self) -> AppResult<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::create_dir_all(&self.logs_dir)?;
        std::fs::create_dir_all(&self.temp_dir)?;
        std::fs::create_dir_all(&self.downloads_dir)?;
        Ok(())
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }

    pub fn temp_dir(&self) -> &Path {
        &self.temp_dir
    }

    pub fn downloads_dir(&self) -> &Path {
        &self.downloads_dir
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::AppPaths;

    #[test]
    fn app_paths_are_derived_from_data_dir() {
        let paths =
            AppPaths::from_data_dir(PathBuf::from("C:/Users/example/AppData/Roaming/zTerm"));

        assert_eq!(
            paths.db_path(),
            PathBuf::from("C:/Users/example/AppData/Roaming/zTerm/zterm.db")
        );
        assert_eq!(
            paths.logs_dir(),
            PathBuf::from("C:/Users/example/AppData/Roaming/zTerm/logs")
        );
        assert_eq!(
            paths.temp_dir(),
            PathBuf::from("C:/Users/example/AppData/Roaming/zTerm/temp")
        );
        assert_eq!(
            paths.downloads_dir(),
            PathBuf::from("C:/Users/example/AppData/Roaming/zTerm/downloads")
        );
    }
}
