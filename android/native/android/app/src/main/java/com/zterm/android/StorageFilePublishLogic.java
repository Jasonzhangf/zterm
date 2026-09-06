package com.zterm.android;

import java.io.File;
import java.io.IOException;
import android.system.ErrnoException;
import android.system.Os;

final class StorageFilePublishLogic {
    private StorageFilePublishLogic() {}

    static void publishAtomically(File source, File target) throws IOException, ErrnoException {
        Os.rename(source.getPath(), target.getPath());
    }

    static long publish(File source, File target, long expectedBytes)
        throws IOException, ErrnoException {
        if (source == null || !source.exists() || !source.isFile()) {
            throw new IOException("Source path is not a file: " + source);
        }
        if (expectedBytes < 0L || source.length() != expectedBytes) {
            throw new IOException(
                "Source size mismatch: " + source.length() + " != " + expectedBytes
            );
        }
        File parent = target.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs())) {
            throw new IOException("Unable to create parent directory: " + target);
        }
        publishAtomically(source, target);
        return expectedBytes;
    }
}
