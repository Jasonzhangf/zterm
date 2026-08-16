package com.zterm.android;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.List;

final class StorageFileWriteLogic {
    private StorageFileWriteLogic() {}

    static long writeChunks(File target, List<byte[]> chunks, boolean append) throws IOException {
        if (chunks == null || chunks.isEmpty()) {
            throw new IOException("write batch requires at least one chunk");
        }
        if (chunks.size() > BuildConfig.FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS) {
            throw new IOException(
                "write batch chunk count exceeds "
                    + BuildConfig.FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS
                    + ": "
                    + chunks.size()
            );
        }

        File parent = target.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) {
            throw new IOException("Unable to create parent directory: " + target.getPath());
        }

        long bytesWritten = 0L;
        try (FileOutputStream output = new FileOutputStream(target, append)) {
            for (byte[] chunk : chunks) {
                if (chunk == null) {
                    throw new IOException("write batch contains a null chunk");
                }
                output.write(chunk);
                bytesWritten += chunk.length;
            }
        }
        return bytesWritten;
    }
}
