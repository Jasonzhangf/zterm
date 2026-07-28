package com.zterm.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class StorageFileWriteLogicTest {

    @Test
    public void writesOneBoundedBatchInExactOrder() throws Exception {
        File file = File.createTempFile("zterm-storage-write", ".bin");
        try {
            List<byte[]> chunks = List.of(
                "part-1|".getBytes(StandardCharsets.UTF_8),
                "part-2".getBytes(StandardCharsets.UTF_8)
            );

            long written = StorageFileWriteLogic.writeChunks(file, chunks, false);

            assertEquals(13L, written);
            assertArrayEquals("part-1|part-2".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file.toPath()));
        } finally {
            file.delete();
        }
    }

    @Test
    public void appendsSubsequentBatchWithoutTruncatingPriorBytes() throws Exception {
        File file = File.createTempFile("zterm-storage-append", ".bin");
        try {
            Files.write(file.toPath(), "first|".getBytes(StandardCharsets.UTF_8));

            StorageFileWriteLogic.writeChunks(
                file,
                List.of("second".getBytes(StandardCharsets.UTF_8)),
                true
            );

            assertArrayEquals("first|second".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file.toPath()));
        } finally {
            file.delete();
        }
    }

    @Test
    public void rejectsEmptyAndOversizedBatches() throws Exception {
        File file = File.createTempFile("zterm-storage-invalid", ".bin");
        try {
            assertThrows(
                IOException.class,
                () -> StorageFileWriteLogic.writeChunks(file, List.of(), false)
            );

            List<byte[]> oversized = new ArrayList<>();
            for (
                int index = 0;
                index <= BuildConfig.FILE_TRANSFER_NATIVE_WRITE_BATCH_CHUNKS;
                index += 1
            ) {
                oversized.add(new byte[] { (byte) index });
            }
            IOException error = assertThrows(
                IOException.class,
                () -> StorageFileWriteLogic.writeChunks(file, oversized, false)
            );
            assertTrue(error.getMessage().contains("batch chunk count exceeds"));
        } finally {
            file.delete();
        }
    }
}
