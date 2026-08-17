// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileTransferSheet } from "./FileTransferSheet";
import { StoragePermissionPlugin } from "../../plugins/StoragePermissionPlugin";

vi.mock("../../plugins/StoragePermissionPlugin", () => ({
  StoragePermissionPlugin: {
    check: vi
      .fn()
      .mockResolvedValue({ granted: true, mode: "manage-external-storage" }),
    request: vi
      .fn()
      .mockResolvedValue({ granted: true, mode: "manage-external-storage" }),
    readdir: vi.fn().mockResolvedValue({ files: [] }),
    stat: vi.fn().mockResolvedValue({
      size: 0,
      modified: 0,
      uri: "file:///storage/emulated/0/Download/zterm",
      type: "directory",
    }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeFileChunks: vi.fn().mockResolvedValue({ bytesWritten: 0 }),
    copyFile: vi.fn().mockResolvedValue({ bytesWritten: 0 }),
    createStableFileSnapshot: vi.fn().mockResolvedValue({
      path: "/storage/emulated/0/Download/zterm/remote-browser/snapshot",
      size: 0,
      modified: 0,
    }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
    readFileChunk: vi.fn().mockResolvedValue({
      data: "",
      bytesRead: 0,
      eof: true,
    }),
    readFile: vi.fn().mockResolvedValue({ data: "IyBMb2NhbA==" }),
  },
}));

const storagePermissionPluginMock = StoragePermissionPlugin as typeof StoragePermissionPlugin & {
  readFileChunk: ReturnType<typeof vi.fn>;
};

if (!HTMLElement.prototype.scrollIntoView) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({
    granted: true,
    mode: "manage-external-storage",
  });
  vi.mocked(StoragePermissionPlugin.check).mockClear();
  vi.mocked(StoragePermissionPlugin.request).mockClear();
  vi.mocked(StoragePermissionPlugin.readdir).mockClear();
  vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
    files: [],
  } as any);
  vi.mocked(StoragePermissionPlugin.stat).mockClear();
  vi.mocked(StoragePermissionPlugin.stat).mockResolvedValue({
    size: 0,
    modified: 0,
    uri: "file:///storage/emulated/0/Download/zterm",
    type: "directory",
  } as any);
  vi.mocked(StoragePermissionPlugin.readFile).mockClear();
  vi.mocked(StoragePermissionPlugin.readFile).mockResolvedValue({
    data: "IyBMb2NhbA==",
  } as any);
  storagePermissionPluginMock.readFileChunk.mockClear();
  storagePermissionPluginMock.readFileChunk.mockResolvedValue({
    data: "",
    bytesRead: 0,
    eof: true,
  });
  vi.mocked(StoragePermissionPlugin.mkdir).mockClear();
  vi.mocked(StoragePermissionPlugin.mkdir).mockResolvedValue(undefined as any);
  vi.mocked(StoragePermissionPlugin.writeFile).mockClear();
  vi.mocked(StoragePermissionPlugin.writeFile).mockResolvedValue(
    undefined as any,
  );
  vi.mocked(StoragePermissionPlugin.writeFileChunks).mockClear();
  vi.mocked(StoragePermissionPlugin.writeFileChunks).mockResolvedValue({
    bytesWritten: 0,
  } as any);
  vi.mocked(StoragePermissionPlugin.copyFile).mockClear();
  vi.mocked(StoragePermissionPlugin.copyFile).mockResolvedValue({
    bytesWritten: 0,
  } as any);
  vi.mocked(StoragePermissionPlugin.createStableFileSnapshot).mockClear();
  vi.mocked(StoragePermissionPlugin.createStableFileSnapshot).mockResolvedValue({
    path: "/storage/emulated/0/Download/zterm/remote-browser/snapshot",
    size: 0,
    modified: 0,
  } as any);
  vi.mocked(StoragePermissionPlugin.deleteFile).mockClear();
  vi.mocked(StoragePermissionPlugin.deleteFile).mockResolvedValue(
    undefined as any,
  );
  vi.mocked(StoragePermissionPlugin.openFile).mockClear();
  vi.mocked(StoragePermissionPlugin.openFile).mockResolvedValue(
    undefined as any,
  );
});

describe("FileTransferSheet", () => {
  it.each(["light", "blue", "black"] as const)(
    "projects the %s terminal shell skin onto the file browser",
    (terminalShellSkin) => {
      render(
        <FileTransferSheet
          open
          remoteCwd="/remote/home"
          terminalShellSkin={terminalShellSkin}
          onClose={vi.fn()}
          sendJson={vi.fn()}
          onFileTransferMessage={vi.fn(() => () => {})}
        />,
      );

      expect(
        screen
          .getByTestId("file-transfer-overlay")
          .getAttribute("data-terminal-shell-skin"),
      ).toBe(terminalShellSkin);
      expect(
        screen.getByTestId("file-transfer-sheet").classList.contains(
          "zterm-file-sheet",
        ),
      ).toBe(true);
    },
  );

  it("requests daemon current session cwd when the sheet opens without a client-side path truth", async () => {
    const sendJson = vi.fn();

    render(
      <FileTransferSheet
        open
        remoteCwd=""
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => {
      expect(sendJson).toHaveBeenCalledWith({
        type: "file-list-request",
        payload: expect.objectContaining({
          path: "",
          showHidden: true,
        }),
      });
    });
  });

  it("does not re-request the same remote directory only because parent passed a new sendJson callback identity", async () => {
    const sendJsonA = vi.fn();
    const sendJsonB = vi.fn();
    const onFileTransferMessage = vi.fn(() => () => {});

    const view = render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJsonA}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => {
      expect(sendJsonA).toHaveBeenCalledWith({
        type: "file-list-request",
        payload: expect.objectContaining({
          path: "/remote/home",
          showHidden: true,
        }),
      });
    });
    const initialCalls = sendJsonA.mock.calls.length;

    view.rerender(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJsonB}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(sendJsonA).toHaveBeenCalledTimes(initialCalls);
    expect(sendJsonB).not.toHaveBeenCalled();
  });

  it("requests storage permission and lists the external storage path through the native storage owner", async () => {
    vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({
      granted: false,
      mode: "manage-external-storage",
    });
    vi.mocked(StoragePermissionPlugin.request).mockResolvedValue({
      granted: true,
      mode: "manage-external-storage",
    });
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "hello.txt",
          type: "file",
          size: 5,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/hello.txt",
        },
      ],
    } as any);

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => {
      expect(StoragePermissionPlugin.check).toHaveBeenCalled();
      expect(StoragePermissionPlugin.request).toHaveBeenCalled();
      expect(StoragePermissionPlugin.readdir).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm",
      });
      expect(screen.getByText("hello.txt")).toBeTruthy();
    });
  });

  it("shows an explicit permission error and does not fake an empty directory when storage permission is still denied", async () => {
    vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({
      granted: false,
      mode: "manage-external-storage",
    });
    vi.mocked(StoragePermissionPlugin.request).mockResolvedValue({
      granted: false,
      mode: "manage-external-storage",
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => {
      expect(StoragePermissionPlugin.request).toHaveBeenCalled();
      expect(StoragePermissionPlugin.readdir).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("本地文件同步需要存储权限");
    });
  });

  it("refreshes permission and re-lists the local directory after app focus returns from Android settings", async () => {
    vi.mocked(StoragePermissionPlugin.check)
      .mockResolvedValueOnce({
        granted: false,
        mode: "manage-external-storage",
      })
      .mockResolvedValueOnce({
        granted: true,
        mode: "manage-external-storage",
      });
    vi.mocked(StoragePermissionPlugin.request).mockResolvedValue({
      granted: false,
      mode: "manage-external-storage",
    });
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "granted-later.txt",
          type: "file",
          size: 13,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/granted-later.txt",
        },
      ],
    } as any);

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("本地文件同步需要存储权限");
    });

    fireEvent(window, new Event("focus"));

    await waitFor(() => {
      expect(StoragePermissionPlugin.readdir).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm",
      });
      expect(screen.getByText("granted-later.txt")).toBeTruthy();
    });
  });

  it("does not filter local image or dot files returned by the native storage owner", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: ".nomedia",
          type: "file",
          size: 0,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/.nomedia",
        },
        {
          name: "photo.jpg",
          type: "file",
          size: 2048,
          modified: 2,
          uri: "file:///storage/emulated/0/Download/photo.jpg",
        },
      ],
    } as any);

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(".nomedia")).toBeTruthy();
      expect(screen.getByText("photo.jpg")).toBeTruthy();
      expect(screen.queryByText("显示 .文件")).toBeNull();
      expect(screen.queryByText("隐藏 .文件")).toBeNull();
    });
  });

  it("sorts local files by modified time in descending order when requested", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "old.txt",
          type: "file",
          size: 1,
          modified: 10,
          uri: "file:///storage/emulated/0/Download/old.txt",
        },
        {
          name: "new.txt",
          type: "file",
          size: 1,
          modified: 20,
          uri: "file:///storage/emulated/0/Download/new.txt",
        },
      ],
    } as any);

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => expect(screen.getByText("old.txt")).toBeTruthy());

    const sortFieldButtons = screen.getAllByText("按名称");
    fireEvent.click(sortFieldButtons[1]);
    const directionButtons = screen.getAllByText("正序");
    fireEvent.click(directionButtons[1]);

    await waitFor(() => {
      const text = document.body.textContent || "";
      expect(text.indexOf("new.txt")).toBeLessThan(text.indexOf("old.txt"));
    });
  });

  it("sorts remote files by modified time in descending order when requested", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [
          { name: "old.png", type: "file", size: 1, modified: 10 },
          { name: "new.png", type: "file", size: 1, modified: 20 },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText("old.png")).toBeTruthy());

    fireEvent.click(screen.getAllByText("按名称")[0]);
    fireEvent.click(screen.getAllByText("正序")[0]);

    await waitFor(() => {
      const text = document.body.textContent || "";
      expect(text.indexOf("new.png")).toBeLessThan(text.indexOf("old.png"));
    });
  });

  it("downloads remote image chunks to local storage without collapsing the write into an empty file", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });
    vi.mocked(StoragePermissionPlugin.stat).mockResolvedValue({
      size: 5,
      modified: 0,
      uri: "file:///storage/emulated/0/Download/zterm/photo.png",
      type: "file",
    } as any);

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "photo.png", type: "file", size: 5, modified: 1 }],
      },
    });

    await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());
    fireEvent.click(screen.getByText("photo.png"));
    fireEvent.click(screen.getByText("下载 1 项"));

    const downloadRequest = sendJson.mock.calls.find(
      (call) => call[0]?.type === "file-download-request",
    )?.[0];
    expect(downloadRequest).toBeTruthy();

    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: downloadRequest.payload.requestId,
        fileName: "photo.png",
        chunkIndex: 0,
        totalChunks: 2,
        dataBase64: "aW1h",
      },
    });
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: downloadRequest.payload.requestId,
        fileName: "photo.png",
        chunkIndex: 1,
        totalChunks: 2,
        dataBase64: "Z2U=",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: downloadRequest.payload.requestId,
        fileName: "photo.png",
        totalBytes: 5,
      },
    });

    await waitFor(() => {
      expect(StoragePermissionPlugin.writeFileChunks).toHaveBeenNthCalledWith(1, {
        path: "/storage/emulated/0/Download/zterm/photo.png",
        chunks: ["aW1h", "Z2U="],
        append: false,
      });
      expect(StoragePermissionPlugin.writeFile).not.toHaveBeenCalled();
      expect(StoragePermissionPlugin.stat).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/photo.png",
      });
    });
  });

  it("uploads local files by reading native file chunks without materializing the whole file in WebView", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = { current: null };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "large.bin",
          type: "file",
          size: 16 * 1024 + 10,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/large.bin",
        },
      ],
    } as any);
    storagePermissionPluginMock.readFileChunk
      .mockResolvedValueOnce({
        data: "Y2h1bmsw",
        bytesRead: 16 * 1024,
        eof: false,
      })
      .mockResolvedValueOnce({
        data: "MTA=",
        bytesRead: 10,
        eof: true,
      });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(screen.getByText("large.bin")).toBeTruthy());
    await waitFor(() => expect(handlerRef.current).toBeTruthy());

    fireEvent.click(screen.getByText("⬆ 上传到远程"));
    fireEvent.click(screen.getByRole("button", { name: "选择本地 large.bin" }));
    fireEvent.click(screen.getByText("上传 1 项"));

    await waitFor(() => {
      expect(StoragePermissionPlugin.readFile).not.toHaveBeenCalled();
      expect(storagePermissionPluginMock.readFileChunk).toHaveBeenNthCalledWith(1, {
        path: "/storage/emulated/0/Download/zterm/large.bin",
        offset: 0,
        length: 16 * 1024,
      });
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-chunk"),
      ).toBe(true);
    });

    const uploadStart = sendJson.mock.calls.find(
      (call) => call[0]?.type === "file-upload-start",
    )?.[0];
    expect(uploadStart).toMatchObject({
      type: "file-upload-start",
      payload: expect.objectContaining({
        targetDir: "/remote/home",
        fileName: "large.bin",
        fileSize: 16 * 1024 + 10,
        chunkCount: 2,
      }),
    });

    handlerRef.current?.({
      type: "file-upload-progress",
      payload: {
        requestId: uploadStart.payload.requestId,
        chunkIndex: 1,
        totalChunks: 2,
      },
    });

    await waitFor(() => {
      expect(storagePermissionPluginMock.readFileChunk).toHaveBeenNthCalledWith(2, {
        path: "/storage/emulated/0/Download/zterm/large.bin",
        offset: 16 * 1024,
        length: 10,
      });
      expect(
        sendJson.mock.calls.filter((call) => call[0]?.type === "file-upload-chunk"),
      ).toHaveLength(2);
    });

    handlerRef.current?.({
      type: "file-upload-progress",
      payload: {
        requestId: uploadStart.payload.requestId,
        chunkIndex: 2,
        totalChunks: 2,
      },
    });
    handlerRef.current?.({
      type: "file-upload-complete",
      payload: {
        requestId: uploadStart.payload.requestId,
        filePath: "/remote/home/large.bin",
        bytes: 16 * 1024 + 10,
      },
    });

    await waitFor(() => {
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-end"),
      ).toBe(true);
    });

    const uploadChunks = sendJson.mock.calls
      .map((call) => call[0])
      .filter((message) => message?.type === "file-upload-chunk");
    expect(uploadChunks).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          requestId: uploadStart.payload.requestId,
          chunkIndex: 0,
          dataBase64: "Y2h1bmsw",
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          requestId: uploadStart.payload.requestId,
          chunkIndex: 1,
          dataBase64: "MTA=",
        }),
      }),
    ]);
  });

  it("keeps each upload wire frame under the RTC-safe character budget", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = { current: null };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });
    const rawChunk = "x".repeat(16 * 1024);
    const dataBase64 = btoa(rawChunk);
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "wire.bin",
          type: "file",
          size: 16 * 1024,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/wire.bin",
        },
      ],
    } as any);
    storagePermissionPluginMock.readFileChunk.mockResolvedValueOnce({
      data: dataBase64,
      bytesRead: 16 * 1024,
      eof: true,
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(screen.getByText("wire.bin")).toBeTruthy());
    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    fireEvent.click(screen.getByText("⬆ 上传到远程"));
    fireEvent.click(screen.getByRole("button", { name: "选择本地 wire.bin" }));
    fireEvent.click(screen.getByText("上传 1 项"));

    await waitFor(() => {
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-chunk"),
      ).toBe(true);
    });

    const uploadStart = sendJson.mock.calls.find(
      (call) => call[0]?.type === "file-upload-start",
    )?.[0];
    handlerRef.current?.({
      type: "file-upload-progress",
      payload: {
        requestId: uploadStart.payload.requestId,
        chunkIndex: 1,
        totalChunks: 1,
      },
    });
    handlerRef.current?.({
      type: "file-upload-complete",
      payload: {
        requestId: uploadStart.payload.requestId,
        filePath: "/remote/home/wire.bin",
        bytes: 16 * 1024,
      },
    });

    await waitFor(() => {
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-end"),
      ).toBe(true);
    });

    const uploadChunks = sendJson.mock.calls
      .map((call) => call[0])
      .filter((message) => message?.type === "file-upload-chunk");
    expect(uploadChunks).toHaveLength(1);
    for (const message of uploadChunks) {
      expect(JSON.stringify(message).length).toBeLessThanOrEqual(48 * 1024);
    }
  });

  it("previews local markdown through bounded native chunks instead of whole-file reads", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "LOCAL.md",
          type: "file",
          size: 700 * 1024,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/LOCAL.md",
        },
      ],
    } as any);
    vi.mocked(StoragePermissionPlugin.stat).mockResolvedValue({
      size: 700 * 1024,
      modified: 1,
      uri: "file:///storage/emulated/0/Download/zterm/LOCAL.md",
      type: "file",
    } as any);
    storagePermissionPluginMock.readFileChunk.mockImplementation(async (args: {
      offset: number;
      length: number;
    }) => {
      const nextOffset = args.offset + args.length;
      return {
        data: args.offset === 0 ? "IyBwYXJ0LTEK" : "IyBwYXJ0LTIK",
        bytesRead: args.length,
        eof: nextOffset >= 512 * 1024,
      };
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => expect(screen.getByText("LOCAL.md")).toBeTruthy());
    fireEvent.click(screen.getByText("LOCAL.md"));

    await waitFor(() => {
      expect(StoragePermissionPlugin.readFile).not.toHaveBeenCalled();
      expect(storagePermissionPluginMock.readFileChunk).toHaveBeenCalled();
      expect(storagePermissionPluginMock.readFileChunk).toHaveBeenNthCalledWith(1, {
        path: "/storage/emulated/0/Download/zterm/LOCAL.md",
        offset: 0,
        length: 16 * 1024,
      });
      const lengths = storagePermissionPluginMock.readFileChunk.mock.calls.map(
        (call) => call[0]?.length,
      );
      expect(lengths.every((length) => length <= 16 * 1024)).toBe(true);
      expect(lengths.some((length) => length > 256 * 1024)).toBe(false);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("file-transfer-md-preview").textContent,
      ).toContain("预览已截断");
    });
  });

  it("keeps truncated local UTF-8 previews open when the byte cap splits a multibyte character", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "SPLIT.md",
          type: "file",
          size: 512 * 1024 + 1,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/SPLIT.md",
        },
      ],
    } as any);
    vi.mocked(StoragePermissionPlugin.stat).mockResolvedValue({
      size: 512 * 1024 + 1,
      modified: 1,
      uri: "file:///storage/emulated/0/Download/zterm/SPLIT.md",
      type: "file",
    } as any);
    storagePermissionPluginMock.readFileChunk.mockImplementation(async (args: {
      offset: number;
      length: number;
    }) => ({
      data: args.offset + args.length >= 512 * 1024 ? "4g==" : "YQ==",
      bytesRead: args.length,
      eof: false,
    }));

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => expect(screen.getByText("SPLIT.md")).toBeTruthy());
    fireEvent.click(screen.getByText("SPLIT.md"));

    await waitFor(() => {
      expect(
        screen.getByTestId("file-transfer-md-preview").textContent,
      ).toContain("预览已截断");
      expect(
        screen.getByTestId("file-transfer-md-preview").textContent,
      ).not.toContain("预览失败");
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
          .disabled,
      ).toBe(false);
    });
  });

  it("does not offer direct remote save for a truncated local text preview", async () => {
    const sendJson = vi.fn();
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "BIG.md",
          type: "file",
          size: 700 * 1024,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/BIG.md",
        },
      ],
    } as any);
    vi.mocked(StoragePermissionPlugin.stat).mockResolvedValue({
      size: 700 * 1024,
      modified: 1,
      uri: "file:///storage/emulated/0/Download/zterm/BIG.md",
      type: "file",
    } as any);
    storagePermissionPluginMock.readFileChunk.mockResolvedValue({
      data: "IyBQYXJ0",
      bytesRead: 16 * 1024,
      eof: false,
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => expect(screen.getByText("BIG.md")).toBeTruthy());
    fireEvent.click(screen.getByText("BIG.md"));

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled).toBe(true);
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
          .disabled,
      ).toBe(false);
    });
    expect(
      sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-start"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.copyFile).toHaveBeenCalledWith({
        sourcePath: "/storage/emulated/0/Download/zterm/BIG.md",
        targetPath:
          "/storage/emulated/0/Download/zterm/remote-browser/local/15-0oa0b4a-0fht6z4/BIG.md",
      });
      expect(StoragePermissionPlugin.writeFileChunks).not.toHaveBeenCalled();
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/local/15-0oa0b4a-0fht6z4/BIG.md",
        mimeType: "text/markdown",
      });
      expect(
        screen.getByRole<HTMLButtonElement>("button", {
          name: "同步本地副本",
        }).disabled,
      ).toBe(false);
    });
  });

  it("opens a local text preview through an edit copy without overwriting the source file", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "SMALL.md",
          type: "file",
          size: 7,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/SMALL.md",
        },
      ],
    } as any);
    vi.mocked(StoragePermissionPlugin.stat).mockResolvedValue({
      size: 7,
      modified: 1,
      uri: "file:///storage/emulated/0/Download/zterm/SMALL.md",
      type: "file",
    } as any);
    storagePermissionPluginMock.readFileChunk.mockResolvedValue({
      data: "IyBMb2NhbA==",
      bytesRead: 7,
      eof: true,
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => expect(screen.getByText("SMALL.md")).toBeTruthy());
    fireEvent.click(screen.getByText("SMALL.md"));
    await waitFor(() => expect(screen.getByLabelText("编辑远程文本")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.writeFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/local/17-1m2yttt-1d3xd3r/SMALL.md",
        data: "IyBMb2NhbA==",
      });
      expect(StoragePermissionPlugin.writeFile).not.toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/storage/emulated/0/Download/zterm/SMALL.md",
        }),
      );
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/local/17-1m2yttt-1d3xd3r/SMALL.md",
        mimeType: "text/markdown",
      });
    });
  });

  it("blocks local preview save when native stat shows the file grew after listing", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "GROWN.md",
          type: "file",
          size: 7,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/GROWN.md",
        },
      ],
    } as any);
    vi.mocked(StoragePermissionPlugin.stat).mockResolvedValue({
      size: 700 * 1024,
      modified: 2,
      uri: "file:///storage/emulated/0/Download/zterm/GROWN.md",
      type: "file",
    } as any);
    storagePermissionPluginMock.readFileChunk
      .mockResolvedValueOnce({
        data: "IyBQYXJ0",
        bytesRead: 6,
        eof: false,
      })
      .mockResolvedValue({
        data: "",
        bytesRead: 0,
        eof: false,
      });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => expect(screen.getByText("GROWN.md")).toBeTruthy());
    fireEvent.click(screen.getByText("GROWN.md"));

    await waitFor(() => {
      expect(
        screen.getByTestId("file-transfer-md-preview").textContent,
      ).toContain("预览已截断");
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "保存" })
          .disabled,
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.copyFile).toHaveBeenCalledWith({
        sourcePath: "/storage/emulated/0/Download/zterm/GROWN.md",
        targetPath:
          "/storage/emulated/0/Download/zterm/remote-browser/local/17-0durot5-1vpnbpk/GROWN.md",
      });
    });
  });

  it("rejects invalid UTF-8 local text previews instead of enabling a lossy save", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockResolvedValue({
      files: [
        {
          name: "BROKEN.md",
          type: "file",
          size: 1,
          modified: 1,
          uri: "file:///storage/emulated/0/Download/zterm/BROKEN.md",
        },
      ],
    } as any);
    vi.mocked(StoragePermissionPlugin.stat).mockResolvedValue({
      size: 1,
      modified: 1,
      uri: "file:///storage/emulated/0/Download/zterm/BROKEN.md",
      type: "file",
    } as any);
    storagePermissionPluginMock.readFileChunk.mockResolvedValue({
      data: "/w==",
      bytesRead: 1,
      eof: true,
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => expect(screen.getByText("BROKEN.md")).toBeTruthy());
    fireEvent.click(screen.getByText("BROKEN.md"));

    await waitFor(() => {
      expect(
        screen.getByTestId("file-transfer-md-preview").textContent,
      ).toContain("预览失败");
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "保存" })
          .disabled,
      ).toBe(true);
      expect(StoragePermissionPlugin.writeFile).not.toHaveBeenCalled();
    });
  });

  it("shows an explicit local directory read error instead of pretending the directory is empty", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockRejectedValue(
      new Error("EACCES"),
    );

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("本地目录读取失败：EACCES");
    });
  });

  it("uses side overlay mode to avoid the active landscape pane", async () => {
    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
        avoidSide="left"
      />,
    );

    expect(
      screen
        .getByTestId("file-transfer-overlay")
        .getAttribute("data-avoid-side"),
    ).toBe("left");
    expect(
      screen.getByTestId("file-transfer-sheet").getAttribute("data-layout"),
    ).toBe("side");
  });

  it("only exposes the sync sheet and does not keep image/file upload entry modes", () => {
    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );

    expect(screen.getByText("文件同步")).toBeTruthy();
    expect(screen.getByText("⬇ 下载到本地")).toBeTruthy();
    expect(screen.getByText("⬆ 上传到远程")).toBeTruthy();
    expect(screen.queryByText("上传图片")).toBeNull();
    expect(screen.queryByText("上传文件")).toBeNull();
    expect(screen.queryByTestId("file-transfer-upload-target")).toBeNull();
  });

  it("opens floating file browser mode without reading or showing the local sync directory", async () => {
    vi.mocked(StoragePermissionPlugin.readdir).mockClear();
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };

    render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd=""
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
          handlerRef.current = nextHandler;
          return () => {};
        })}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/cwd",
        parentPath: "/remote",
        entries: [
          { name: "src", type: "directory", size: 0, modified: 1 },
          { name: "app.ts", type: "file", size: 7, modified: 1 },
        ],
      },
    });

    expect(screen.getByText("文件浏览")).toBeTruthy();
    expect(screen.queryByText("文件同步")).toBeNull();
    expect(screen.queryByText("⬇ 下载到本地")).toBeNull();
    expect(screen.queryByText("⬆ 上传到远程")).toBeNull();
    expect(screen.queryByText(/本地:/)).toBeNull();
    await waitFor(() => expect(screen.getByText("app.ts")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "选择远程 app.ts" })).toBeNull();
    expect(StoragePermissionPlugin.readdir).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-transfer-sheet").style.height).toBe("auto");
  });

  it("shows remote browser list errors explicitly instead of projecting an empty cwd", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };

    render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd=""
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
          handlerRef.current = nextHandler;
          return () => {};
        })}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-error",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        error: "tmux pane current path unavailable",
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId("file-transfer-remote-error").textContent).toContain(
        "远程目录读取失败：tmux pane current path unavailable",
      );
    });
    expect(screen.queryByText("空目录")).toBeNull();
  });

  it("uses browser mode as a remote cwd browser and reports unsupported files instead of selecting them for sync", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };

    render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd=""
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
          handlerRef.current = nextHandler;
          return () => {};
        })}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/cwd",
        parentPath: "/remote",
        entries: [{ name: "archive.zip", type: "file", size: 120, modified: 1 }],
      },
    });

    await waitFor(() => expect(screen.getByText("archive.zip")).toBeTruthy());
    fireEvent.click(screen.getByText("archive.zip"));

    await waitFor(() => {
      expect(screen.getByTestId("file-transfer-md-preview").textContent).toContain(
        "当前只支持文本和代码文件预览/编辑",
      );
    });
    expect(screen.queryByText("下载 1 项")).toBeNull();
  });

  it("still opens the app sheet with an explicit unavailable state when transfer transport is not ready", () => {
    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={undefined}
        onFileTransferMessage={undefined}
      />,
    );

    expect(screen.getByTestId("file-transfer-sheet")).toBeTruthy();
    expect(
      screen.getByTestId("file-transfer-unavailable").textContent,
    ).toContain("文件同步通道未就绪");
  });

  it("clicking a remote markdown file name opens an in-sheet preview request", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "README.md", type: "file", size: 7, modified: 1 }],
      },
    });

    await waitFor(() => expect(screen.getByText("README.md")).toBeTruthy());
    fireEvent.click(screen.getByText("README.md"));

    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    expect(previewRequest).toMatchObject({
      type: "file-download-request",
      payload: expect.objectContaining({ fileName: "README.md" }),
    });
    expect(
      screen.getByTestId("file-transfer-md-preview").textContent,
    ).toContain("加载预览中");
  });

  it("opens text preview as a fullscreen file view and returns to the file list", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "DELIVERY.md", type: "file", size: 9, modified: 1 }],
      },
    });

    await waitFor(() => expect(screen.getByText("DELIVERY.md")).toBeTruthy());
    fireEvent.click(screen.getByText("DELIVERY.md"));

    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "DELIVERY.md",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "IyBEb25l",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "DELIVERY.md",
        totalBytes: 6,
      },
    });

    await waitFor(() => {
      expect(
        screen
          .getByTestId("file-transfer-md-preview")
          .getAttribute("data-preview-open"),
      ).toBe("fullscreen");
      expect(screen.getByRole("button", { name: "← 返回" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "编辑" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "保存" })).toBeTruthy();
      expect(screen.getByLabelText("编辑远程文本")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(screen.getByLabelText("编辑远程文本"));
    const previewToolbar = screen.getByRole("button", { name: "← 返回" })
      .parentElement as HTMLElement;
    expect(previewToolbar.style.flexWrap).toBe("wrap");
    expect(
      (screen.getByRole("button", { name: "保存" }).parentElement as HTMLElement)
        .style.flexWrap,
    ).toBe("wrap");

    fireEvent.click(screen.getByRole("button", { name: "← 返回" }));

    await waitFor(() => {
      expect(screen.queryByTestId("file-transfer-md-preview")).toBeNull();
      expect(screen.getByText("DELIVERY.md")).toBeTruthy();
    });
  });

  it("clicking a remote markdown checkbox selects it for download without opening preview", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "USER.md", type: "file", size: 13_900, modified: 1 }],
      },
    });

    await waitFor(() => expect(screen.getByText("USER.md")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "选择远程 USER.md" }));

    expect(screen.queryByTestId("file-transfer-md-preview")).toBeNull();
    expect(
      sendJson.mock.calls.some((call) =>
        call[0]?.payload?.requestId?.startsWith("fpv-"),
      ),
    ).toBe(false);
    expect(screen.getByText("下载 1 项")).toBeTruthy();
  });

  it("saves edited remote text through the bounded upload protocol", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "app.ts", type: "file", size: 11, modified: 1 }],
      },
    });

    await waitFor(() => expect(screen.getByText("app.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("app.ts"));

    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "app.ts",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "Y29uc29sZS5sb2coMSk=",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "app.ts",
        totalBytes: 14,
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("编辑远程文本")).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText("编辑远程文本"), {
      target: { value: "console.log(2)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-chunk"),
      ).toBe(true);
    });
    const uploadStart = sendJson.mock.calls.find(
      (call) => call[0]?.type === "file-upload-start",
    )?.[0];
    expect(uploadStart).toMatchObject({
      type: "file-upload-start",
      payload: expect.objectContaining({
        targetDir: "/remote/home",
        fileName: "app.ts",
      }),
    });

    handlerRef.current?.({
      type: "file-upload-progress",
      payload: {
        requestId: uploadStart.payload.requestId,
        chunkIndex: 1,
        totalChunks: 1,
      },
    });

    await waitFor(() => {
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-end"),
      ).toBe(true);
    });
    handlerRef.current?.({
      type: "file-upload-complete",
      payload: {
        requestId: uploadStart.payload.requestId,
        filePath: "/remote/home/app.ts",
        bytes: 14,
      },
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("已保存到远端");
    });
  });

  it("preserves a remote UTF-8 BOM when saving an unchanged preview", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "bom.ts", type: "file", size: 17, modified: 1 }],
      },
    });

    await waitFor(() => expect(screen.getByText("bom.ts")).toBeTruthy());
    fireEvent.click(screen.getByText("bom.ts"));

    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "bom.ts",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "77u/Y29uc29sZS5sb2coMSk=",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "bom.ts",
        totalBytes: 17,
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("编辑远程文本")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      const uploadChunk = sendJson.mock.calls.find(
        (call) => call[0]?.type === "file-upload-chunk",
      )?.[0];
      expect(uploadChunk?.payload.dataBase64).toBe("77u/Y29uc29sZS5sb2coMSk=");
    });
  });

  it("keeps save enabled when remote file text contains the local truncation notice words", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const noticeText = "预览已截断 只是远端文件正文，当前预览不能直接保存到远端";

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
          handlerRef.current = nextHandler;
          return () => {};
        })}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "notice.md", type: "file", size: 36, modified: 1 }],
      },
    });
    await waitFor(() => expect(screen.getByText("notice.md")).toBeTruthy());
    fireEvent.click(screen.getByText("notice.md"));

    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "notice.md",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: Buffer.from(noticeText, "utf8").toString("base64"),
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "notice.md",
        totalBytes: Buffer.from(noticeText, "utf8").byteLength,
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("编辑远程文本")).toBeTruthy();
      expect(screen.getByDisplayValue(noticeText)).toBeTruthy();
      expect(
        screen.queryByText(
          "预览已截断，请用本地打开编辑完整副本；当前预览不能直接保存到远端。",
        ),
      ).toBeNull();
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "保存" })
          .disabled,
      ).toBe(false);
    });
  });

  it("saves an intentionally emptied remote text file instead of restoring the old preview", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "empty.md", type: "file", size: 7, modified: 1 }],
      },
    });
    await waitFor(() => expect(screen.getByText("empty.md")).toBeTruthy());
    fireEvent.click(screen.getByText("empty.md"));

    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "empty.md",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "IyBPbGQ=",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "empty.md",
        totalBytes: 5,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLTextAreaElement>("编辑远程文本").value,
      ).toBe("# Old");
    });
    fireEvent.change(screen.getByLabelText("编辑远程文本"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-chunk"),
      ).toBe(true);
    });
    const uploadStart = sendJson.mock.calls.find(
      (call) => call[0]?.type === "file-upload-start",
    )?.[0];
    const uploadChunk = sendJson.mock.calls.find(
      (call) => call[0]?.type === "file-upload-chunk",
    )?.[0];
    expect(uploadStart.payload).toMatchObject({
      fileName: "empty.md",
      fileSize: 0,
      chunkCount: 1,
    });
    expect(uploadChunk.payload.dataBase64).toBe("");
  });

  it("writes the preview to local storage before opening it with a native editor", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "README.md", type: "file", size: 7, modified: 1 }],
      },
    });
    await waitFor(() => expect(screen.getByText("README.md")).toBeTruthy());
    fireEvent.click(screen.getByText("README.md"));
    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "README.md",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "IyBUaXRsZQ==",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "README.md",
        totalBytes: 7,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.writeFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md",
        data: "IyBUaXRsZQ==",
      });
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md",
        mimeType: "text/markdown",
      });
    });

    vi.mocked(StoragePermissionPlugin.createStableFileSnapshot).mockResolvedValue({
      path: "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md.zterm-upload-snapshot",
      size: 9,
      modified: 2,
    } as any);
    vi.mocked(StoragePermissionPlugin.stat).mockImplementation(async ({ path }) => {
      if (
        path ===
        "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md"
      ) {
        return {
          size: 9,
          modified: 11,
          uri: `file://${path}`,
          type: "file",
        } as any;
      }
      return {
        size: 0,
        modified: 0,
        uri: "file:///storage/emulated/0/Download/zterm",
        type: "directory",
      } as any;
    });
    storagePermissionPluginMock.readFileChunk.mockResolvedValue({
      data: "IyBDaGFuZ2Vk",
      bytesRead: 9,
      eof: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "同步本地副本" }));

    await waitFor(() => {
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-chunk"),
      ).toBe(true);
    });
    const uploadStart = sendJson.mock.calls.find(
      (call) => call[0]?.type === "file-upload-start",
    )?.[0];
    expect(uploadStart.payload).toMatchObject({
      targetDir: "/remote/home",
      fileName: "README.md",
      fileSize: 9,
      chunkCount: 1,
    });
    expect(StoragePermissionPlugin.createStableFileSnapshot).toHaveBeenCalledWith({
      sourcePath: "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md",
      snapshotPath:
        "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md.zterm-upload-snapshot",
    });
    expect(StoragePermissionPlugin.readFileChunk).toHaveBeenCalledWith({
      path: "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md.zterm-upload-snapshot",
      offset: 0,
      length: 9,
    });
    expect(
      sendJson.mock.calls.find((call) => call[0]?.type === "file-upload-chunk")
        ?.[0].payload.dataBase64,
    ).toBe("IyBDaGFuZ2Vk");

    handlerRef.current?.({
      type: "file-upload-progress",
      payload: {
        requestId: uploadStart.payload.requestId,
        chunkIndex: 1,
        totalChunks: 1,
      },
    });

    await waitFor(() => {
      expect(
        sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-end"),
      ).toBe(true);
    });
    handlerRef.current?.({
      type: "file-upload-complete",
      payload: {
        requestId: uploadStart.payload.requestId,
        filePath: "/remote/home/README.md",
        bytes: 9,
      },
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("本地副本已同步到远端");
      expect(StoragePermissionPlugin.stat).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md",
      });
      expect(StoragePermissionPlugin.deleteFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md.zterm-upload-snapshot",
      });
    });
  });

  async function renderBrowserTextPreview(options?: {
    sendJson?: ReturnType<typeof vi.fn>;
    onClose?: ReturnType<typeof vi.fn>;
    daemonFileScopeId?: string;
  }) {
    const sendJson = options?.sendJson ?? vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });
    const rendered = render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd="/Users/jason/project"
        onClose={options?.onClose ?? vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
        daemonFileScopeId={options?.daemonFileScopeId}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/Users/jason/project",
        parentPath: "/Users/jason",
        entries: [{ name: "README.md", type: "file", size: 7, modified: 1 }],
      },
    });
    await waitFor(() => expect(screen.getByText("README.md")).toBeTruthy());
    fireEvent.click(screen.getByText("README.md"));
    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "README.md",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "IyBUaXRsZQ==",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "README.md",
        totalBytes: 7,
      },
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLTextAreaElement>("编辑远程文本").value,
      ).toBe("# Title");
    });
    return { ...rendered, sendJson, handlerRef, onFileTransferMessage };
  }

  it("serializes fullscreen preview saves while an upload is in flight", async () => {
    const onClose = vi.fn();
    await renderBrowserTextPreview({ onClose });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "保存" }).disabled)
        .toBe(true);
      expect(screen.getByLabelText<HTMLTextAreaElement>("编辑远程文本").disabled)
        .toBe(true);
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "← 返回" }).disabled)
        .toBe(true);
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "关闭" }).disabled)
        .toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "← 返回" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByTestId("file-transfer-md-preview")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("surfaces a visible save error when the file-transfer channel is gone", async () => {
    const sendJson = vi.fn();
    const rendered = await renderBrowserTextPreview({ sendJson });

    rendered.rerender(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd="/Users/jason/project"
        onClose={vi.fn()}
        onFileTransferMessage={vi.fn(() => () => {})}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "保存失败：文件传输通道未就绪",
      );
    });
  });

  it("surfaces denied storage permission when opening a preview locally", async () => {
    await renderBrowserTextPreview();
    vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({
      granted: false,
      mode: "manage-external-storage",
    });
    vi.mocked(StoragePermissionPlugin.request).mockResolvedValue({
      granted: false,
      mode: "manage-external-storage",
    });

    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "本地打开失败：未获得本地存储权限。",
      );
      expect(StoragePermissionPlugin.openFile).not.toHaveBeenCalled();
    });
  });

  it("fails local edit-copy open visibly when edit-copy state cannot be persisted", async () => {
    const setItemSpy = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      await renderBrowserTextPreview();
      fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

      await waitFor(() => {
        expect(StoragePermissionPlugin.writeFile).toHaveBeenCalled();
        expect(StoragePermissionPlugin.openFile).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain("本地打开失败：quota exceeded");
      });
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it("surfaces denied storage permission when syncing a local edit copy", async () => {
    await renderBrowserTextPreview();

    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));
    await waitFor(() => {
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalled();
    });
    vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({
      granted: false,
      mode: "manage-external-storage",
    });
    vi.mocked(StoragePermissionPlugin.request).mockResolvedValue({
      granted: false,
      mode: "manage-external-storage",
    });

    fireEvent.click(screen.getByRole("button", { name: "同步本地副本" }));

    await waitFor(() => {
      expect(document.body.textContent).toContain("同步失败：未获得本地存储权限。");
      expect(StoragePermissionPlugin.createStableFileSnapshot).not.toHaveBeenCalled();
    });
  });

  it("rejects external edit-copy sync when native snapshot detects local changes", async () => {
    const { sendJson } = await renderBrowserTextPreview();

    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));
    await waitFor(() => {
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalled();
    });

    vi.mocked(StoragePermissionPlugin.createStableFileSnapshot).mockRejectedValue(
      new Error("Source file changed while creating snapshot"),
    );
    sendJson.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "同步本地副本" }));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "同步失败：Source file changed while creating snapshot",
      );
    });
    expect(StoragePermissionPlugin.readFileChunk).not.toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining("zterm-upload-snapshot"),
      }),
    );
    expect(
      sendJson.mock.calls.some((call) => call[0]?.type === "file-upload-start"),
    ).toBe(false);
  });

  it("scopes browser edit-copy state by daemon target identity", async () => {
    const first = await renderBrowserTextPreview({ daemonFileScopeId: "daemon-a" });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));
    await waitFor(() => {
      expect(StoragePermissionPlugin.writeFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/1f-07j0e4a-0s890bg/README.md",
        data: "IyBUaXRsZQ==",
      });
    });
    first.unmount();

    vi.mocked(StoragePermissionPlugin.writeFile).mockClear();
    vi.mocked(StoragePermissionPlugin.openFile).mockClear();

    await renderBrowserTextPreview({ daemonFileScopeId: "daemon-b" });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.writeFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/1f-1xcxeyz-0gmgmd5/README.md",
        data: "IyBUaXRsZQ==",
      });
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/1f-1xcxeyz-0gmgmd5/README.md",
        mimeType: "text/markdown",
      });
    });
  });

  it("clears browser preview and external edit state when daemon scope changes in place", async () => {
    const rendered = await renderBrowserTextPreview({ daemonFileScopeId: "daemon-a" });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "同步本地副本" })).toBeTruthy();
    });

    rendered.rerender(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd="/Users/jason/project"
        onClose={vi.fn()}
        sendJson={rendered.sendJson}
        onFileTransferMessage={rendered.onFileTransferMessage}
        daemonFileScopeId="daemon-b"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("file-transfer-md-preview")).toBeNull();
      expect(screen.queryByRole("button", { name: "同步本地副本" })).toBeNull();
    });
  });

  it("keeps browser external edits in a remote-browser copy path before syncing back", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const onFileTransferMessage = vi.fn((nextHandler: (msg: any) => void) => {
      handlerRef.current = nextHandler;
      return () => {};
    });

    render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd=""
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={onFileTransferMessage}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/Users/jason/project",
        parentPath: "/Users/jason",
        entries: [{ name: "Dockerfile", type: "file", size: 7, modified: 1 }],
      },
    });
    await waitFor(() => expect(screen.getByText("Dockerfile")).toBeTruthy());
    fireEvent.click(screen.getByText("Dockerfile"));

    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "Dockerfile",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "RlJPTSBub2Rl",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "Dockerfile",
        totalBytes: 9,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.writeFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/v-1fczd7z-0vpzwi1/Dockerfile",
        data: "RlJPTSBub2Rl",
      });
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/v-1fczd7z-0vpzwi1/Dockerfile",
        mimeType: "text/plain",
      });
    });

    vi.mocked(StoragePermissionPlugin.writeFile).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalledTimes(2);
      expect(StoragePermissionPlugin.openFile).toHaveBeenLastCalledWith({
        path: "/storage/emulated/0/Download/zterm/remote-browser/remote/v-1fczd7z-0vpzwi1/Dockerfile",
        mimeType: "text/plain",
      });
      expect(StoragePermissionPlugin.writeFile).not.toHaveBeenCalled();
    });
    expect(StoragePermissionPlugin.readdir).not.toHaveBeenCalled();
  });

  it("reopens an existing browser edit copy after sheet lifecycle reset without overwriting it", async () => {
    const targetPath =
      "/storage/emulated/0/Download/zterm/remote-browser/remote/v-1fczd7z-0vpzwi1/Dockerfile";
    const renderPreview = async () => {
      const sendJson = vi.fn();
      const handlerRef: { current: ((msg: any) => void) | null } = {
        current: null,
      };
      render(
        <FileTransferSheet
          open
          mode="browser"
          remoteCwd="/Users/jason/project"
          onClose={vi.fn()}
          sendJson={sendJson}
          onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
            handlerRef.current = nextHandler;
            return () => {};
          })}
        />,
      );

      await waitFor(() => expect(handlerRef.current).toBeTruthy());
      handlerRef.current?.({
        type: "file-list-response",
        payload: {
          requestId: sendJson.mock.calls[0][0].payload.requestId,
          path: "/Users/jason/project",
          parentPath: "/Users/jason",
          entries: [{ name: "Dockerfile", type: "file", size: 9, modified: 1 }],
        },
      });
      await waitFor(() => expect(screen.getByText("Dockerfile")).toBeTruthy());
      fireEvent.click(screen.getByText("Dockerfile"));
      const previewRequest = sendJson.mock.calls.find((call) =>
        call[0]?.payload?.requestId?.startsWith("fpv-"),
      )?.[0];
      handlerRef.current?.({
        type: "file-download-chunk",
        payload: {
          requestId: previewRequest.payload.requestId,
          fileName: "Dockerfile",
          chunkIndex: 0,
          totalChunks: 1,
          dataBase64: "RlJPTSBub2Rl",
        },
      });
      handlerRef.current?.({
        type: "file-download-complete",
        payload: {
          requestId: previewRequest.payload.requestId,
          fileName: "Dockerfile",
          totalBytes: 9,
        },
      });
      await waitFor(() => {
        expect(
          screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
            .disabled,
        ).toBe(false);
      });
    };

    await renderPreview();
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));
    await waitFor(() => {
      expect(StoragePermissionPlugin.writeFile).toHaveBeenCalledWith({
        path: targetPath,
        data: "RlJPTSBub2Rl",
      });
    });

    cleanup();
    vi.mocked(StoragePermissionPlugin.writeFile).mockClear();
    vi.mocked(StoragePermissionPlugin.openFile).mockClear();
    vi.mocked(StoragePermissionPlugin.stat).mockImplementation(async (args: any) => {
      if (args.path === targetPath) {
        return {
          size: 19,
          modified: 2,
          uri: `file://${targetPath}`,
          type: "file",
        } as any;
      }
      return {
        size: 0,
        modified: 0,
        uri: "file:///storage/emulated/0/Download/zterm",
        type: "directory",
      } as any;
    });

    await renderPreview();
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.openFile).toHaveBeenCalledWith({
        path: targetPath,
        mimeType: "text/plain",
      });
      expect(StoragePermissionPlugin.writeFile).not.toHaveBeenCalled();
    });
  });

  it("fails closed instead of overwriting an edit copy when native stat is unavailable", async () => {
    const targetPath =
      "/storage/emulated/0/Download/zterm/remote-browser/remote/v-1fczd7z-0vpzwi1/Dockerfile";
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd="/Users/jason/project"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
          handlerRef.current = nextHandler;
          return () => {};
        })}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/Users/jason/project",
        parentPath: "/Users/jason",
        entries: [{ name: "Dockerfile", type: "file", size: 9, modified: 1 }],
      },
    });
    await waitFor(() => expect(screen.getByText("Dockerfile")).toBeTruthy());
    fireEvent.click(screen.getByText("Dockerfile"));
    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "Dockerfile",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "RlJPTSBub2Rl",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "Dockerfile",
        totalBytes: 9,
      },
    });
    vi.mocked(StoragePermissionPlugin.stat).mockRejectedValue(new Error("EIO"));

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(document.body.textContent).toContain("本地打开失败：EIO");
      expect(StoragePermissionPlugin.writeFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: targetPath }),
      );
    });
  });

  it("replaces a synced unchanged edit copy with the fresh remote preview", async () => {
    const targetPath =
      "/storage/emulated/0/Download/zterm/remote-browser/remote/m-0dzld6g-16w3kij/README.md";
    window.localStorage.setItem(
      "zterm:file-browser-edit-copy:v1:remote:m-0dzld6g-16w3kij",
      JSON.stringify({
        state: "synced",
        sourceIdentity: "/remote/home/README.md",
        path: targetPath,
        fileName: "README.md",
        size: 7,
        modified: 100,
      }),
    );
    vi.mocked(StoragePermissionPlugin.stat).mockImplementation(async (args: any) => {
      if (args.path === targetPath) {
        return {
          size: 7,
          modified: 100,
          uri: `file://${targetPath}`,
          type: "file",
        } as any;
      }
      return {
        size: 0,
        modified: 0,
        uri: "file:///storage/emulated/0/Download/zterm",
        type: "directory",
      } as any;
    });
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd="/remote/home"
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
          handlerRef.current = nextHandler;
          return () => {};
        })}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: "/remote/home",
        parentPath: "/remote",
        entries: [{ name: "README.md", type: "file", size: 9, modified: 2 }],
      },
    });
    await waitFor(() => expect(screen.getByText("README.md")).toBeTruthy());
    fireEvent.click(screen.getByText("README.md"));
    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "README.md",
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "IyBOZXc=",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: "README.md",
        totalBytes: 5,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => {
      expect(StoragePermissionPlugin.writeFile).toHaveBeenCalledWith({
        path: targetPath,
        data: "IyBOZXc=",
      });
    });
  });

  it("keeps remote edit-copy paths unique for sanitized-looking path collisions", async () => {
    const openCopyForRemotePath = async (remoteCwd: string) => {
      const sendJson = vi.fn();
      const handlerRef: { current: ((msg: any) => void) | null } = {
        current: null,
      };

      render(
        <FileTransferSheet
          open
          mode="browser"
          remoteCwd={remoteCwd}
          onClose={vi.fn()}
          sendJson={sendJson}
          onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
            handlerRef.current = nextHandler;
            return () => {};
          })}
        />,
      );

      await waitFor(() => expect(handlerRef.current).toBeTruthy());
      handlerRef.current?.({
        type: "file-list-response",
        payload: {
          requestId: sendJson.mock.calls[0][0].payload.requestId,
          path: remoteCwd,
          parentPath: "/",
          entries: [{ name: "same.txt", type: "file", size: 2, modified: 1 }],
        },
      });
      await waitFor(() => expect(screen.getByText("same.txt")).toBeTruthy());
      fireEvent.click(screen.getByText("same.txt"));

      const previewRequest = sendJson.mock.calls.find((call) =>
        call[0]?.payload?.requestId?.startsWith("fpv-"),
      )?.[0];
      handlerRef.current?.({
        type: "file-download-chunk",
        payload: {
          requestId: previewRequest.payload.requestId,
          fileName: "same.txt",
          chunkIndex: 0,
          totalChunks: 1,
          dataBase64: "aGk=",
        },
      });
      handlerRef.current?.({
        type: "file-download-complete",
        payload: {
          requestId: previewRequest.payload.requestId,
          fileName: "same.txt",
          totalBytes: 2,
        },
      });

      await waitFor(() => {
        expect(
          screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
            .disabled,
        ).toBe(false);
      });
      fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

      await waitFor(() => expect(StoragePermissionPlugin.writeFile).toHaveBeenCalled());
      const path = vi.mocked(StoragePermissionPlugin.writeFile).mock.calls[0][0]
        .path;
      cleanup();
      vi.mocked(StoragePermissionPlugin.writeFile).mockClear();
      vi.mocked(StoragePermissionPlugin.openFile).mockClear();
      return path;
    };

    const slashPath = await openCopyForRemotePath("/foo/bar");
    const dashPath = await openCopyForRemotePath("/foo-bar");

    expect(slashPath).toBe(
      "/storage/emulated/0/Download/zterm/remote-browser/remote/h-1mlixqx-0s6w851/same.txt",
    );
    expect(dashPath).toBe(
      "/storage/emulated/0/Download/zterm/remote-browser/remote/h-1yuc31v-1yl3n5f/same.txt",
    );
    expect(slashPath).not.toBe(dashPath);
  });

  it("keeps browser edit-copy paths bounded for deeply nested remote files", async () => {
    const sendJson = vi.fn();
    const handlerRef: { current: ((msg: any) => void) | null } = {
      current: null,
    };
    const longRemotePath = `/${"deep/".repeat(180)}`;
    const longFileName = `${"verylongfilename".repeat(12)}.md`;

    render(
      <FileTransferSheet
        open
        mode="browser"
        remoteCwd={longRemotePath}
        onClose={vi.fn()}
        sendJson={sendJson}
        onFileTransferMessage={vi.fn((nextHandler: (msg: any) => void) => {
          handlerRef.current = nextHandler;
          return () => {};
        })}
      />,
    );

    await waitFor(() => expect(handlerRef.current).toBeTruthy());
    handlerRef.current?.({
      type: "file-list-response",
      payload: {
        requestId: sendJson.mock.calls[0][0].payload.requestId,
        path: longRemotePath,
        parentPath: "/",
        entries: [{ name: longFileName, type: "file", size: 2, modified: 1 }],
      },
    });
    await waitFor(() => expect(screen.getByText(longFileName)).toBeTruthy());
    fireEvent.click(screen.getByText(longFileName));
    const previewRequest = sendJson.mock.calls.find((call) =>
      call[0]?.payload?.requestId?.startsWith("fpv-"),
    )?.[0];
    handlerRef.current?.({
      type: "file-download-chunk",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: longFileName,
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: "aGk=",
      },
    });
    handlerRef.current?.({
      type: "file-download-complete",
      payload: {
        requestId: previewRequest.payload.requestId,
        fileName: longFileName,
        totalBytes: 2,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "本地打开" })
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));

    await waitFor(() => expect(StoragePermissionPlugin.writeFile).toHaveBeenCalled());
    const path = vi.mocked(StoragePermissionPlugin.writeFile).mock.calls[0][0]
      .path;
    const pathParts = path.split("/");
    const fileNameComponent = pathParts[pathParts.length - 1] || "";
    expect(path.length).toBeLessThan(180);
    expect(fileNameComponent.length).toBeLessThanOrEqual(80);
    expect(path).toMatch(
      /^\/storage\/emulated\/0\/Download\/zterm\/remote-browser\/remote\/[a-z0-9-]+\/verylongfilename/,
    );
    expect(path).not.toContain("deep/deep");
  });
});
