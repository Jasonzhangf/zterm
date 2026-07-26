package com.zterm.android;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;

@CapacitorPlugin(name = "StoragePermission")
public class StoragePermissionPlugin extends Plugin {
    private static final int STORAGE_PERMISSION_REQUEST_CODE = 1001;

    private boolean hasStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return Environment.isExternalStorageManager();
        }
        return ContextCompat.checkSelfPermission(getActivity(), Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
            && ContextCompat.checkSelfPermission(getActivity(), Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject buildPermissionResult() {
        JSObject result = new JSObject();
        result.put("granted", hasStoragePermission());
        result.put("mode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? "manage-external-storage" : "legacy-read-write");
        return result;
    }

    private File resolveExternalStoragePath(String inputPath) throws IOException {
        String path = inputPath == null ? "" : inputPath.trim();
        File root = Environment.getExternalStorageDirectory().getCanonicalFile();
        File target;
        if (path.length() == 0 || "/".equals(path)) {
            target = root;
        } else {
            File inputFile = new File(path);
            target = inputFile.isAbsolute() ? inputFile : new File(root, path);
        }
        File canonicalTarget = target.getCanonicalFile();
        String rootPath = root.getPath();
        String targetPath = canonicalTarget.getPath();
        if (!targetPath.equals(rootPath) && !targetPath.startsWith(rootPath + File.separator)) {
            throw new IOException("Path is outside external storage: " + inputPath);
        }
        return canonicalTarget;
    }

    private boolean ensureStoragePermission(PluginCall call) {
        if (hasStoragePermission()) {
            return true;
        }
        call.reject("Storage permission is not granted");
        return false;
    }

    private long readLongOption(PluginCall call, String name, long defaultValue) throws IOException {
        Object value = call.getData().opt(name);
        if (value == null) {
            return defaultValue;
        }
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        if (value instanceof String) {
            try {
                return Long.parseLong((String) value);
            } catch (NumberFormatException error) {
                throw new IOException(name + " must be a number");
            }
        }
        throw new IOException(name + " must be a number");
    }

    private int readIntOption(PluginCall call, String name, int defaultValue) throws IOException {
        long value = readLongOption(call, name, defaultValue);
        if (value < Integer.MIN_VALUE || value > Integer.MAX_VALUE) {
            throw new IOException(name + " is outside integer range");
        }
        return (int) value;
    }

    private JSObject buildFileEntry(File file) {
        JSObject data = new JSObject();
        data.put("name", file.getName());
        data.put("type", file.isDirectory() ? "directory" : "file");
        data.put("size", file.isFile() ? file.length() : 0);
        data.put("modified", file.lastModified());
        data.put("uri", Uri.fromFile(file).toString());
        return data;
    }

    @PluginMethod
    public void check(PluginCall call) {
        call.resolve(buildPermissionResult());
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (hasStoragePermission()) {
            call.resolve(buildPermissionResult());
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(intent);
            } catch (Exception error) {
                Intent intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                getActivity().startActivity(intent);
            }
            call.resolve(buildPermissionResult());
            return;
        }

        ActivityCompat.requestPermissions(
            getActivity(),
            new String[]{Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE},
            STORAGE_PERMISSION_REQUEST_CODE
        );
        call.resolve(buildPermissionResult());
    }

    @PluginMethod
    public void readdir(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        String path = call.getString("path", "");
        try {
            File dir = resolveExternalStoragePath(path);
            if (!dir.exists()) {
                call.reject("Directory does not exist: " + dir.getPath());
                return;
            }
            if (!dir.isDirectory()) {
                call.reject("Path is not a directory: " + dir.getPath());
                return;
            }
            File[] files = dir.listFiles();
            if (files == null) {
                call.reject("Unable to list directory: " + dir.getPath());
                return;
            }
            Arrays.sort(files, Comparator
                .comparing((File file) -> !file.isDirectory())
                .thenComparing(file -> file.getName().toLowerCase()));
            JSArray filesArray = new JSArray();
            for (File file : files) {
                filesArray.put(buildFileEntry(file));
            }
            JSObject result = new JSObject();
            result.put("files", filesArray);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            if (!target.exists()) {
                call.reject("Path does not exist: " + target.getPath());
                return;
            }
            call.resolve(buildFileEntry(target));
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void readFile(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            if (!target.exists() || !target.isFile()) {
                call.reject("Path is not a file: " + target.getPath());
                return;
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (FileInputStream input = new FileInputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                }
            }
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void readFileChunk(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            StorageFileReadLogic.Chunk chunk = StorageFileReadLogic.readChunk(
                target,
                readLongOption(call, "offset", 0L),
                readIntOption(call, "length", StorageFileReadLogic.MAX_CHUNK_BYTES)
            );
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(chunk.bytes, Base64.NO_WRAP));
            result.put("bytesRead", chunk.bytesRead);
            result.put("eof", chunk.eof);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void writeFile(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            File parent = target.getParentFile();
            if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                call.reject("Unable to create parent directory: " + target.getPath());
                return;
            }
            String data = call.getString("data", "");
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            try (FileOutputStream output = new FileOutputStream(target)) {
                output.write(bytes);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void writeFileChunk(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            File parent = target.getParentFile();
            if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                call.reject("Unable to create parent directory: " + target.getPath());
                return;
            }
            String data = call.getString("data", "");
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            boolean append = Boolean.TRUE.equals(call.getBoolean("append", false));
            try (FileOutputStream output = new FileOutputStream(target, append)) {
                output.write(bytes);
            }
            JSObject result = new JSObject();
            result.put("bytesWritten", bytes.length);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        boolean recursive = Boolean.TRUE.equals(call.getBoolean("recursive", false));
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            if (target.exists()) {
                if (target.isDirectory()) {
                    call.resolve();
                    return;
                }
                call.reject("Path exists and is not a directory: " + target.getPath());
                return;
            }
            boolean created = recursive ? target.mkdirs() : target.mkdir();
            if (!created) {
                call.reject("Unable to create directory: " + target.getPath());
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }
}
