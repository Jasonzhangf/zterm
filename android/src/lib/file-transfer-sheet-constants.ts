/**
 * FileTransferSheet 路径/容量常量子模块（client.file_browser）。
 */

export const LOCAL_MARKDOWN_PREVIEW_MAX_BYTES = 512 * 1024;
export const REMOTE_TEXT_EDIT_MAX_BYTES = 512 * 1024;
export const EXTERNAL_STORAGE_ROOT = "/storage/emulated/0";
export const DEFAULT_LOCAL_DOWNLOAD_DIR = `${EXTERNAL_STORAGE_ROOT}/Download/zterm`;
// Verification-only 50MB E2E harness. Do not use as normal download destination.
export const VERIFICATION_LOCAL_DOWNLOAD_DIR = "/data/data/com.zterm.android/files/zterm-verification";
export const BROWSER_LOCAL_EDIT_DIR = `${DEFAULT_LOCAL_DOWNLOAD_DIR}/remote-browser`;
export const LOCAL_EDIT_COPY_NAME_MAX_CHARS = 80;
