package com.zterm.android;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

@CapacitorPlugin(name = "PickedImageUri")
public class PickedImageUriPlugin extends Plugin {
    private static final String TAG = "PickedImageUriPlugin";
    private static final long MAX_PICKED_IMAGE_BYTES = 25L * 1024 * 1024;
    private String pickerCallId;

    @PluginMethod
    public void pickImage(PluginCall call) {
        this.pickerCallId = call.getCallbackId();
        Log.i(TAG, "pickImage start callback=" + call.getCallbackId());
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("image/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(call, intent, "onPickImageResult");
            Log.i(TAG, "pickImage launched picker");
        } catch (Exception error) {
            Log.e(TAG, "failed to launch image picker", error);
            call.reject("无法打开图片选择器: " + error.getMessage());
        }
    }

    @Override
    public Bundle saveInstanceState() {
        Bundle state = new Bundle();
        String callId = this.pickerCallId;
        if (callId != null) {
            state.putString("pickImageCallId", callId);
            state.putBoolean("pickImageSaved", true);
            Log.i(TAG, "saveInstanceState pickImageCallId=" + callId);
        }
        return state;
    }

    @Override
    protected void restoreState(Bundle state) {
        if (state != null && state.getBoolean("pickImageSaved", false)) {
            Log.i(TAG, "restoreState pickImageCallId=" + state.getString("pickImageCallId"));
        }
    }

    @ActivityCallback
    private void onPickImageResult(PluginCall call, ActivityResult result) {
        Log.i(TAG, "onPickImageResult resultCode=" + (result == null ? "null" : String.valueOf(result.getResultCode())));
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK) {
            Log.i(TAG, "onPickImageResult no data, resolving");
            call.resolve();
            return;
        }
        Intent data = result.getData();
        if (data == null || data.getData() == null) {
            Log.e(TAG, "onPickImageResult missing data uri");
            call.reject("图片选择器未返回可读取的图片");
            return;
        }
        Uri uri = data.getData();
        Log.i(TAG, "onPickImageResult uri=" + uri);
        String mimeType = getContext().getContentResolver().getType(uri);
        if (mimeType == null) {
            mimeType = "image/*";
        }
        String name = queryDisplayName(uri);
        Log.i(TAG, "onPickImageResult name=" + name + " mime=" + mimeType);
        JSObject selection = new JSObject();
        selection.put("uri", uri.toString());
        selection.put("mimeType", mimeType);
        selection.put("name", name);
        call.resolve(selection);
    }

    @PluginMethod
    public void readContentUri(PluginCall call) {
        String uriText = call.getString("uri");
        if (uriText == null || uriText.isEmpty()) {
            call.reject("缺少图片 content uri");
            return;
        }
        try {
            Uri uri = Uri.parse(uriText);
            Log.i(TAG, "readContentUri start uri=" + uri);
            long declaredSize = queryDeclaredSize(uri);
            if (declaredSize > MAX_PICKED_IMAGE_BYTES) {
                call.reject(oversizedImageMessage());
                return;
            }
            byte[] bytes;
            try (InputStream inputStream = getContext().getContentResolver().openInputStream(uri)) {
                if (inputStream == null) {
                    call.reject("无法打开所选图片");
                    return;
                }
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[64 * 1024];
                int read;
                long total = 0;
                while ((read = inputStream.read(chunk)) != -1) {
                    total += read;
                    if (total > MAX_PICKED_IMAGE_BYTES) {
                        call.reject(oversizedImageMessage());
                        return;
                    }
                    buffer.write(chunk, 0, read);
                }
                bytes = buffer.toByteArray();
            }
            Log.i(TAG, "readContentUri bytes=" + bytes.length);
            if (bytes.length == 0) {
                call.reject("所选图片内容为空");
                return;
            }
            String dataBase64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            String mimeType = call.getString("mimeType");
            if (mimeType == null || mimeType.isEmpty()) {
                mimeType = getContext().getContentResolver().getType(uri);
            }
            if (mimeType == null || mimeType.isEmpty()) {
                mimeType = "application/octet-stream";
            }
            String name = call.getString("name");
            if (name == null || name.isEmpty()) {
                name = queryDisplayName(uri);
            }
            JSObject result = new JSObject();
            result.put("dataBase64", dataBase64);
            result.put("mime", mimeType);
            result.put("name", name);
            result.put("size", bytes.length);
            call.resolve(result);
        } catch (Exception error) {
            Log.e(TAG, "failed to read picked image", error);
            call.reject("读取所选图片失败: " + error.getMessage());
        }
    }

    private String oversizedImageMessage() {
        return "所选图片超过 " + (MAX_PICKED_IMAGE_BYTES / (1024 * 1024)) + " MB 上限";
    }

    private long queryDeclaredSize(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(
                uri,
                new String[] { OpenableColumns.SIZE },
                null,
                null,
                null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    return cursor.getLong(sizeIndex);
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "query declared size failed", error);
        }
        return -1L;
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(
                uri,
                new String[] { OpenableColumns.DISPLAY_NAME },
                null,
                null,
                null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (nameIndex >= 0) {
                    String name = cursor.getString(nameIndex);
                    if (name != null && !name.isEmpty()) {
                        return name;
                    }
                }
            }
        } catch (Exception error) {
            Log.w(TAG, "query display name failed", error);
        }
        return "picked-image.png";
    }
}
