package com.zterm.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class StorageFilePublishLogicInstrumentedTest {

    @Test
    public void publishesSameDirectoryStagingFileAfterExactSizeCheck() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        File directory = new File(context.getCacheDir(), "zterm-publish-instrumented");
        deleteRecursively(directory);
        assertEquals(true, directory.mkdirs());
        File staging = new File(directory, ".download.part");
        File target = new File(directory, "download.bin");
        try {
            Files.write(staging.toPath(), "payload".getBytes(StandardCharsets.UTF_8));

            long published = StorageFilePublishLogic.publish(staging, target, 7L);

            assertEquals(7L, published);
            assertArrayEquals(
                "payload".getBytes(StandardCharsets.UTF_8),
                Files.readAllBytes(target.toPath())
            );
            assertFalse(staging.exists());
        } finally {
            deleteRecursively(directory);
        }
    }

    private static void deleteRecursively(File file) {
        if (!file.exists()) {
            return;
        }
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
