package com.zterm.android;

import android.Manifest;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.system.Os;
import android.util.Base64;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
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
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

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

    private File createSiblingTempFile(File target) throws IOException {
        File parent = target.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) {
            throw new IOException("Unable to create parent directory: " + target.getPath());
        }
        String prefix = target.getName();
        if (prefix.length() < 3) {
            prefix = "zterm-" + prefix;
        }
        return File.createTempFile(prefix, ".tmp", parent);
    }

    private void publishTempFileAtomically(File temp, File target) throws Exception {
        Os.rename(temp.getPath(), target.getPath());
    }

    private long copyFileToOutput(File source, FileOutputStream output) throws IOException {
        long copiedBytes = 0L;
        try (FileInputStream input = new FileInputStream(source)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                copiedBytes += read;
            }
        }
        output.getFD().sync();
        return copiedBytes;
    }

    private boolean sameFileIdentity(File file, long size, long modified) {
        return file.exists() && file.isFile() && file.length() == size && file.lastModified() == modified;
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
            File temp = createSiblingTempFile(target);
            boolean published = false;
            try (FileOutputStream output = new FileOutputStream(temp, false)) {
                output.write(bytes);
                output.getFD().sync();
                publishTempFileAtomically(temp, target);
                published = true;
            } finally {
                if (!published && temp.exists()) {
                    temp.delete();
                }
            }
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void writeFileChunks(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            JSArray encodedChunks = call.getArray("chunks");
            if (encodedChunks == null) {
                call.reject("write batch requires chunks");
                return;
            }
            List<byte[]> chunks = new ArrayList<>();
            for (int index = 0; index < encodedChunks.length(); index += 1) {
                chunks.add(Base64.decode(encodedChunks.getString(index), Base64.DEFAULT));
            }
            Boolean append = call.getBoolean("append");
            if (append == null) {
                call.reject("write batch requires append truth");
                return;
            }
            long bytesWritten = StorageFileWriteLogic.writeChunks(target, chunks, append);
            JSObject result = new JSObject();
            result.put("bytesWritten", bytesWritten);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void copyFile(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File source = resolveExternalStoragePath(call.getString("sourcePath", ""));
            File target = resolveExternalStoragePath(call.getString("targetPath", ""));
            if (!source.exists() || !source.isFile()) {
                call.reject("Source path is not a file: " + source.getPath());
                return;
            }
            File parent = target.getParentFile();
            if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                call.reject("Unable to create parent directory: " + target.getPath());
                return;
            }
            File temp = createSiblingTempFile(target);
            long copiedBytes = 0L;
            boolean published = false;
            try (FileOutputStream output = new FileOutputStream(temp, false)) {
                copiedBytes = copyFileToOutput(source, output);
                publishTempFileAtomically(temp, target);
                published = true;
            } finally {
                if (!published && temp.exists()) {
                    temp.delete();
                }
            }
            JSObject result = new JSObject();
            result.put("bytesWritten", copiedBytes);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void createStableFileSnapshot(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File source = resolveExternalStoragePath(call.getString("sourcePath", ""));
            File snapshot = resolveExternalStoragePath(call.getString("snapshotPath", ""));
            if (!source.exists() || !source.isFile()) {
                call.reject("Source path is not a file: " + source.getPath());
                return;
            }
            long sourceSize = source.length();
            long sourceModified = source.lastModified();
            File temp = createSiblingTempFile(snapshot);
            long copiedBytes = 0L;
            boolean published = false;
            try (FileOutputStream output = new FileOutputStream(temp, false)) {
                copiedBytes = copyFileToOutput(source, output);
                if (copiedBytes != sourceSize || !sameFileIdentity(source, sourceSize, sourceModified)) {
                    throw new IOException("Source file changed while creating snapshot");
                }
                publishTempFileAtomically(temp, snapshot);
                published = true;
            } finally {
                if (!published && temp.exists()) {
                    temp.delete();
                }
            }
            JSObject result = new JSObject();
            result.put("path", snapshot.getPath());
            result.put("size", copiedBytes);
            result.put("modified", snapshot.lastModified());
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            if (!target.exists()) {
                call.resolve();
                return;
            }
            if (!target.isFile()) {
                call.reject("Path is not a file: " + target.getPath());
                return;
            }
            if (!target.delete()) {
                call.reject("Unable to delete file: " + target.getPath());
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        if (!ensureStoragePermission(call)) {
            return;
        }
        try {
            File target = resolveExternalStoragePath(call.getString("path", ""));
            if (!target.exists() || !target.isFile()) {
                call.reject("Path is not a file: " + target.getPath());
                return;
            }
            String explicitMime = call.getString("mimeType", "");
            String mimeType = explicitMime == null || explicitMime.trim().isEmpty()
                ? guessMimeType(target)
                : explicitMime.trim();
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                target
            );
            Intent intent = new Intent(Intent.ACTION_EDIT);
            intent.setDataAndType(uri, mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(Intent.createChooser(intent, "Open file"));
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    private String guessMimeType(File target) {
        String name = target.getName();
        int dotIndex = name.lastIndexOf('.');
        if (dotIndex >= 0 && dotIndex + 1 < name.length()) {
            String extension = name.substring(dotIndex + 1).toLowerCase();
            String detected = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            if (detected != null && !detected.trim().isEmpty()) {
                return detected;
            }
        }
        return "text/plain";
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

    /**
     * Save a base64-encoded file to the public Downloads directory (visible to the
     * user in the system file manager / Downloads app).
     * Android 10+ uses MediaStore.Downloads (no permission required); legacy uses
     * the public Downloads directory (WRITE_EXTERNAL_STORAGE).
     */
    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String dataBase64 = call.getString("dataBase64");
        String fileName = call.getString("fileName");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (dataBase64 == null || fileName == null || fileName.isEmpty()) {
            call.reject("dataBase64 and fileName are required");
            return;
        }
        if (fileName.indexOf('/') >= 0 || fileName.indexOf('\\') >= 0) {
            call.reject("fileName must not contain path separators");
            return;
        }
        try {
            byte[] data = Base64.decode(dataBase64, Base64.DEFAULT);
            String path = saveToPublicDownloads(data, fileName, mimeType);
            JSObject result = new JSObject();
            result.put("path", path);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("save failed: " + error.getMessage());
        }
    }

    private String saveToPublicDownloads(byte[] data, String fileName, String mimeType) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            Uri item = getContext().getContentResolver().insert(collection, values);
            if (item == null) {
                throw new IOException("MediaStore insert returned null");
            }
            try (OutputStream output = getContext().getContentResolver().openOutputStream(item)) {
                if (output == null) {
                    throw new IOException("MediaStore openOutputStream returned null");
                }
                output.write(data);
            }
            return item.toString();
        }
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("Unable to create Downloads directory: " + dir.getPath());
        }
        File target = new File(dir, fileName);
        try (FileOutputStream output = new FileOutputStream(target)) {
            output.write(data);
        }
        return target.getAbsolutePath();
    }
}
