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
import { Filesystem } from "@capacitor/filesystem";

vi.mock("@capacitor/filesystem", () => ({
  Directory: {
    ExternalStorage: "ExternalStorage",
  },
  Filesystem: {
    readdir: vi.fn().mockResolvedValue({ files: [] }),
    stat: vi.fn().mockResolvedValue({ size: 0 }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue({ data: "IyBMb2NhbA==" }),
  },
}));

vi.mock("../../plugins/StoragePermissionPlugin", () => ({
  StoragePermissionPlugin: {
    check: vi
      .fn()
      .mockResolvedValue({ granted: true, mode: "manage-external-storage" }),
    request: vi
      .fn()
      .mockResolvedValue({ granted: true, mode: "manage-external-storage" }),
  },
}));

afterEach(() => {
  cleanup();
  vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({
    granted: true,
    mode: "manage-external-storage",
  });
  vi.mocked(StoragePermissionPlugin.request).mockClear();
  vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] } as any);
  vi.mocked(Filesystem.stat).mockResolvedValue({ size: 0 } as any);
  vi.mocked(Filesystem.readFile).mockResolvedValue({
    data: "IyBMb2NhbA==",
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
          showHidden: false,
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
          showHidden: false,
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

  it("does not request storage permission when local sync lacks install-time authorization", async () => {
    vi.mocked(StoragePermissionPlugin.check).mockResolvedValue({
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
      expect(StoragePermissionPlugin.check).toHaveBeenCalled();
      expect(StoragePermissionPlugin.request).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("本地文件同步需要存储权限");
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

  it("clicking a remote markdown file opens an in-sheet preview request instead of selecting it for transfer", async () => {
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
});
