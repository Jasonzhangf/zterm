package com.zterm.android;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final String TAG = "AppUpdatePlugin";

    @PluginMethod
    public void canRequestPackageInstalls(PluginCall call) {
        JSObject result = new JSObject();
        result.put("allowed", canInstallPackages());
        call.resolve(result);
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法打开安装权限设置", error);
        }
    }

    @PluginMethod
    public void backupCurrentApk(PluginCall call) {
        new Thread(() -> {
            try {
                JSObject result = backupCurrentApkInternal();
                call.resolve(result);
            } catch (Exception error) {
                Log.e(TAG, "backupCurrentApk failed", error);
                call.reject(error.getMessage(), error);
            }
        }).start();
    }

    @PluginMethod
    public void rollbackToBackup(PluginCall call) {
        String filePath = call.getString("filePath", "").trim();
        String sha256 = call.getString("sha256", "").trim().toLowerCase(Locale.US);
        if (filePath.isEmpty()) {
            call.reject("回滚备份 filePath 不能为空");
            return;
        }

        new Thread(() -> {
            try {
                File backupFile = new File(filePath);
                if (!backupFile.exists() || !backupFile.isFile()) {
                    throw new IllegalStateException("回滚备份文件不存在");
                }
                if (!sha256.isEmpty()) {
                    String actualSha256 = computeSha256(backupFile);
                    if (!sha256.equals(actualSha256)) {
                        throw new IllegalStateException("回滚备份校验失败：SHA-256 不匹配");
                    }
                }

                getActivity().runOnUiThread(() -> {
                    try {
                        installApk(backupFile);
                        call.resolve();
                    } catch (Exception error) {
                        call.reject("调起回滚安装失败", error);
                    }
                });
            } catch (Exception error) {
                Log.e(TAG, "rollbackToBackup failed", error);
                call.reject(error.getMessage(), error);
            }
        }).start();
    }

    @PluginMethod
    public void getRollbackBackupInfo(PluginCall call) {
        try {
            JSObject result = resolveLatestRollbackBackup();
            if (result == null) {
                call.resolve();
                return;
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("读取回滚备份信息失败", error);
        }
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url", "").trim();
        String sha256 = call.getString("sha256", "").trim().toLowerCase(Locale.US);
        String expectedPackageName = call.getString("expectedPackageName", "").trim();

        if (url.isEmpty()) {
            call.reject("升级包 URL 不能为空");
            return;
        }

        new Thread(() -> {
            File targetFile = null;
            try {
                targetFile = downloadApk(url, sha256);
                String resolvedPackageName = resolvePackageName(targetFile);

                if (!expectedPackageName.isEmpty() && !expectedPackageName.equals(resolvedPackageName)) {
                    throw new IllegalStateException("升级包包名校验失败");
                }

                if (!canInstallPackages()) {
                    getActivity().runOnUiThread(() -> {
                        try {
                            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            getActivity().startActivity(intent);
                            call.reject("需要先允许安装未知来源应用");
                        } catch (Exception error) {
                            call.reject("无法打开安装权限设置", error);
                        }
                    });
                    return;
                }

                File finalTargetFile = targetFile;
                getActivity().runOnUiThread(() -> {
                    try {
                        installApk(finalTargetFile);
                        JSObject result = new JSObject();
                        result.put("filePath", finalTargetFile.getAbsolutePath());
                        result.put("sha256", computeSha256(finalTargetFile));
                        result.put("packageName", resolvedPackageName);
                        call.resolve(result);
                    } catch (Exception error) {
                        call.reject("调起安装失败", error);
                    }
                });
            } catch (Exception error) {
                Log.e(TAG, "downloadAndInstall failed", error);
                if (targetFile != null && targetFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    targetFile.delete();
                }
                call.reject(error.getMessage(), error);
            }
        }).start();
    }

    private boolean canInstallPackages() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return true;
        }
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    private File downloadApk(String sourceUrl, String expectedSha256) throws Exception {
        HttpURLConnection connection = null;
        InputStream inputStream = null;
        FileOutputStream outputStream = null;

        File updatesDir = new File(getContext().getCacheDir(), "updates");
        if (!updatesDir.exists() && !updatesDir.mkdirs()) {
          throw new IllegalStateException("无法创建升级缓存目录");
        }
        File targetFile = new File(updatesDir, "update-" + System.currentTimeMillis() + ".apk");

        try {
            URL url = new URL(sourceUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(true);
            connection.connect();

            int statusCode = connection.getResponseCode();
            if (statusCode < 200 || statusCode >= 300) {
                String reasonMessage = connection.getResponseMessage();
                String detail = "下载升级包失败：HTTP " + statusCode
                    + (reasonMessage != null && !reasonMessage.isEmpty() ? " " + reasonMessage : "")
                    + " (URL: " + sourceUrl + ")";
                throw new IllegalStateException(detail);
            }

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            inputStream = connection.getInputStream();
            outputStream = new FileOutputStream(targetFile);
            byte[] buffer = new byte[8192];
            int read;
            while ((read = inputStream.read(buffer)) >= 0) {
                if (read == 0) {
                    continue;
                }
                outputStream.write(buffer, 0, read);
                digest.update(buffer, 0, read);
            }
            outputStream.flush();

            String actualSha256 = toHex(digest.digest());
            if (!expectedSha256.isEmpty() && !expectedSha256.equals(actualSha256)) {
                throw new IllegalStateException("升级包校验失败：SHA-256 不匹配 (expected=" + expectedSha256 + " actual=" + actualSha256 + ", URL: " + sourceUrl + ")");
            }

            return targetFile;
        } finally {
            if (outputStream != null) {
                try {
                    outputStream.close();
                } catch (Exception ignored) {}
            }
            if (inputStream != null) {
                try {
                    inputStream.close();
                } catch (Exception ignored) {}
            }
            if (connection != null) {
                connection.disconnect();
            }
        }
    }


    private JSObject backupCurrentApkInternal() throws Exception {
        File rollbackDir = getRollbackDir();
        deleteRollbackBackups(rollbackDir);

        ApplicationInfo applicationInfo = getContext().getApplicationInfo();
        String sourceApkPath = applicationInfo != null ? applicationInfo.sourceDir : null;
        if (sourceApkPath == null || sourceApkPath.isEmpty()) {
            throw new IllegalStateException("无法定位当前安装包路径");
        }

        PackageManager packageManager = getContext().getPackageManager();
        PackageInfo packageInfo;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageInfo = packageManager.getPackageInfo(
                getContext().getPackageName(),
                PackageManager.PackageInfoFlags.of(0)
            );
        } else {
            //noinspection deprecation
            packageInfo = packageManager.getPackageInfo(getContext().getPackageName(), 0);
        }

        long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? packageInfo.getLongVersionCode()
            : packageInfo.versionCode;
        String versionName = packageInfo.versionName != null ? packageInfo.versionName : String.valueOf(versionCode);
        long backedUpAt = System.currentTimeMillis();
        File sourceFile = new File(sourceApkPath);
        File backupFile = new File(rollbackDir, "rollback-" + versionCode + "-" + backedUpAt + ".apk");
        copyFile(sourceFile, backupFile);
        String sha256 = computeSha256(backupFile);

        JSObject result = new JSObject();
        result.put("versionCode", versionCode);
        result.put("versionName", versionName);
        result.put("filePath", backupFile.getAbsolutePath());
        result.put("sha256", sha256);
        result.put("backedUpAt", backedUpAt);
        return result;
    }

    private File getRollbackDir() throws Exception {
        File rollbackDir = new File(getContext().getFilesDir(), "rollback");
        if (!rollbackDir.exists() && !rollbackDir.mkdirs()) {
            throw new IllegalStateException("无法创建回滚备份目录");
        }
        return rollbackDir;
    }

    private void deleteRollbackBackups(File rollbackDir) {
        File[] files = rollbackDir.listFiles();
        if (files == null) {
            return;
        }
        for (File file : files) {
            if (file != null && file.isFile()) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
        }
    }

    private JSObject resolveLatestRollbackBackup() throws Exception {
        File rollbackDir = getRollbackDir();
        File[] files = rollbackDir.listFiles((dir, name) -> name.endsWith(".apk"));
        if (files == null || files.length == 0) {
            return null;
        }
        File latest = files[0];
        for (File file : files) {
            if (file.lastModified() > latest.lastModified()) {
                latest = file;
            }
        }

        PackageManager packageManager = getContext().getPackageManager();
        PackageInfo packageInfo;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageInfo = packageManager.getPackageArchiveInfo(
                latest.getAbsolutePath(),
                PackageManager.PackageInfoFlags.of(0)
            );
        } else {
            //noinspection deprecation
            packageInfo = packageManager.getPackageArchiveInfo(latest.getAbsolutePath(), 0);
        }
        if (packageInfo == null) {
            return null;
        }
        long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? packageInfo.getLongVersionCode()
            : packageInfo.versionCode;
        String versionName = packageInfo.versionName != null ? packageInfo.versionName : String.valueOf(versionCode);

        JSObject result = new JSObject();
        result.put("versionCode", versionCode);
        result.put("versionName", versionName);
        result.put("filePath", latest.getAbsolutePath());
        result.put("sha256", computeSha256(latest));
        result.put("backedUpAt", latest.lastModified());
        return result;
    }

    private void copyFile(File source, File target) throws Exception {
        InputStream inputStream = null;
        FileOutputStream outputStream = null;
        try {
            inputStream = new FileInputStream(source);
            outputStream = new FileOutputStream(target);
            byte[] buffer = new byte[8192];
            int read;
            while ((read = inputStream.read(buffer)) >= 0) {
                if (read == 0) {
                    continue;
                }
                outputStream.write(buffer, 0, read);
            }
            outputStream.flush();
        } finally {
            if (outputStream != null) {
                try { outputStream.close(); } catch (Exception ignored) {}
            }
            if (inputStream != null) {
                try { inputStream.close(); } catch (Exception ignored) {}
            }
        }
    }

    private void installApk(File file) throws Exception {
        Uri uri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            file
        );
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        getActivity().startActivity(intent);
        terminateCurrentProcessAfterInstallerHandoff();
    }

    private void terminateCurrentProcessAfterInstallerHandoff() {
        getActivity().getWindow().getDecorView().postDelayed(() -> {
            try {
                getActivity().finishAndRemoveTask();
            } catch (Exception error) {
                Log.w(TAG, "failed to finish activity after installer handoff", error);
            }
            android.os.Process.killProcess(android.os.Process.myPid());
        }, 750L);
    }

    private String resolvePackageName(File apkFile) throws Exception {
        PackageManager packageManager = getContext().getPackageManager();
        PackageInfo packageInfo;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageInfo = packageManager.getPackageArchiveInfo(
                apkFile.getAbsolutePath(),
                PackageManager.PackageInfoFlags.of(0)
            );
        } else {
            //noinspection deprecation
            packageInfo = packageManager.getPackageArchiveInfo(apkFile.getAbsolutePath(), 0);
        }

        if (packageInfo == null || packageInfo.packageName == null || packageInfo.packageName.isEmpty()) {
            throw new IllegalStateException("无法解析升级包包名");
        }

        return packageInfo.packageName;
    }

    private String computeSha256(File file) throws Exception {
        InputStream inputStream = null;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            inputStream = new java.io.FileInputStream(file);
            byte[] buffer = new byte[8192];
            int read;
            while ((read = inputStream.read(buffer)) >= 0) {
                if (read == 0) {
                    continue;
                }
                digest.update(buffer, 0, read);
            }
            return toHex(digest.digest());
        } finally {
            if (inputStream != null) {
                try {
                    inputStream.close();
                } catch (Exception ignored) {}
            }
        }
    }

    private String toHex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) {
            builder.append(String.format(Locale.US, "%02x", item));
        }
        return builder.toString();
    }
}
