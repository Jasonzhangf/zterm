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

afterEach(() => {
  cleanup();
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
});

describe("FileTransferSheet", () => {
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
    expect(screen.getByTestId("file-transfer-md-preview").textContent).toContain(
      "预览已截断",
    );
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
});
