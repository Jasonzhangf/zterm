package com.zterm.android;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

class StorageFileReadLogic {
    static final int MAX_CHUNK_BYTES = 1024 * 1024;

    static class Chunk {
        final byte[] bytes;
        final int bytesRead;
        final boolean eof;

        Chunk(byte[] bytes, int bytesRead, boolean eof) {
            this.bytes = bytes;
            this.bytesRead = bytesRead;
            this.eof = eof;
        }
    }

    static Chunk readChunk(File target, long offset, int length) throws IOException {
        if (target == null || !target.exists() || !target.isFile()) {
            throw new IOException("Path is not a file: " + (target == null ? "" : target.getPath()));
        }
        if (offset < 0) {
            throw new IOException("offset must be >= 0");
        }
        if (length < 0) {
            throw new IOException("length must be >= 0");
        }
        if (length > MAX_CHUNK_BYTES) {
            throw new IOException("read chunk length exceeds " + MAX_CHUNK_BYTES + " bytes");
        }

        long fileSize = target.length();
        if (offset > fileSize) {
            throw new IOException("offset is beyond end of file");
        }

        int bytesToRead = (int) Math.min((long) length, fileSize - offset);
        byte[] bytes = new byte[bytesToRead];
        if (bytesToRead > 0) {
            try (RandomAccessFile input = new RandomAccessFile(target, "r")) {
                input.seek(offset);
                input.readFully(bytes);
            }
        }
        boolean eof = offset + bytesToRead >= fileSize;
        return new Chunk(bytes, bytesToRead, eof);
    }
}
