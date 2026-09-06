package com.zterm.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

public class StorageFilePublishLogicTest {

    @Test
    public void rejectsSizeMismatchAndLeavesExistingTargetUntouched() throws Exception {
        File directory = Files.createTempDirectory("zterm-publish-mismatch").toFile();
        File staging = new File(directory, ".download.part");
        File target = new File(directory, "download.bin");
        try {
            Files.write(staging.toPath(), "short".getBytes(StandardCharsets.UTF_8));
            Files.write(target.toPath(), "old".getBytes(StandardCharsets.UTF_8));

            IOException error = assertThrows(
                IOException.class,
                () -> StorageFilePublishLogic.publish(staging, target, 9L)
            );

            assertTrue(error.getMessage().contains("Source size mismatch"));
            assertArrayEquals(
                "old".getBytes(StandardCharsets.UTF_8),
                Files.readAllBytes(target.toPath())
            );
            assertTrue(staging.exists());
        } finally {
            deleteRecursively(directory);
        }
    }

    private static void deleteRecursively(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        file.delete();
    }
}
