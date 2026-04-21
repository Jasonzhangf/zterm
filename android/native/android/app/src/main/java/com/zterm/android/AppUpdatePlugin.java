package com.zterm.android;

import android.content.Intent;
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
                throw new IllegalStateException("下载升级包失败：HTTP " + statusCode);
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
                throw new IllegalStateException("升级包校验失败：SHA-256 不匹配");
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

