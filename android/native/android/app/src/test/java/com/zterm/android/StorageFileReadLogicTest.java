package com.zterm.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

public class StorageFileReadLogicTest {

    @Test
    public void readsOnlyRequestedChunkAsBase64() throws Exception {
        File file = File.createTempFile("zterm-storage-read", ".bin");
        try {
            Files.write(file.toPath(), "0123456789".getBytes());

            StorageFileReadLogic.Chunk first = StorageFileReadLogic.readChunk(file, 0, 4);
            StorageFileReadLogic.Chunk second = StorageFileReadLogic.readChunk(file, 4, 6);

            assertEquals("0123", new String(first.bytes, StandardCharsets.UTF_8));
            assertEquals(4, first.bytesRead);
            assertFalse(first.eof);
            assertEquals("456789", new String(second.bytes, StandardCharsets.UTF_8));
            assertEquals(6, second.bytesRead);
            assertTrue(second.eof);
        } finally {
            file.delete();
        }
    }

    @Test
    public void zeroByteReadDoesNotMaterializeTheWholeFile() throws Exception {
        File file = File.createTempFile("zterm-storage-zero-read", ".bin");
        try {
            Files.write(file.toPath(), "data".getBytes());

            StorageFileReadLogic.Chunk chunk = StorageFileReadLogic.readChunk(file, 0, 0);

            assertEquals(0, chunk.bytes.length);
            assertEquals(0, chunk.bytesRead);
            assertFalse(chunk.eof);
        } finally {
            file.delete();
        }
    }

    @Test
    public void rejectsOversizedBridgeChunks() throws Exception {
        File file = File.createTempFile("zterm-storage-large-read", ".bin");
        try {
            Files.write(file.toPath(), "data".getBytes());

            IOException error = assertThrows(
                IOException.class,
                () -> StorageFileReadLogic.readChunk(
                    file,
                    0,
                    StorageFileReadLogic.MAX_CHUNK_BYTES + 1
                )
            );

            assertTrue(error.getMessage().contains("read chunk length exceeds"));
        } finally {
            file.delete();
        }
    }
}
