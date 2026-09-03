import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import useApiResource from "./useApiResource";

function Probe({ fetcher, deps = [], options = {} }) {
  const { data, error, loading, initialLoading, reload } = useApiResource(fetcher, deps, options);

  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="initial">{String(initialLoading)}</span>
      <span data-testid="data">{data ?? "none"}</span>
      <span data-testid="error">{error?.message ?? "none"}</span>
      <button type="button" onClick={reload}>
        reload
      </button>
    </div>
  );
}

describe("useApiResource", () => {
  it("loads, then reports the value", async () => {
    render(<Probe fetcher={async () => "value"} />);

    expect(screen.getByTestId("loading")).toHaveTextContent("true");

    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("value"));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("captures a rejection as error rather than throwing", async () => {
    render(<Probe fetcher={async () => Promise.reject(new Error("boom"))} />);

    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("boom"));
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("does not fetch at all when disabled", async () => {
    const fetcher = vi.fn(async () => "value");

    render(<Probe fetcher={fetcher} options={{ enabled: false }} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refetches when a dependency changes", async () => {
    const fetcher = vi.fn(async () => "value");

    const { rerender } = render(<Probe fetcher={fetcher} deps={["a"]} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    rerender(<Probe fetcher={fetcher} deps={["b"]} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("does NOT refetch when only the fetcher identity changes", async () => {
    const calls = { count: 0 };

    const { rerender } = render(
      <Probe
        fetcher={async () => {
          calls.count += 1;
          return "value";
        }}
        deps={["stable"]}
      />,
    );

    await waitFor(() => expect(calls.count).toBe(1));

    // A new closure every render is the normal case; it must not loop.
    rerender(
      <Probe
        fetcher={async () => {
          calls.count += 1;
          return "value";
        }}
        deps={["stable"]}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.count).toBe(1);
  });

  it("reload() refetches on demand", async () => {
    const fetcher = vi.fn(async () => "value");

    render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => screen.getByText("reload").click());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("aborts the in-flight request when the key changes", async () => {
    const seen = [];

    const fetcher = vi.fn(
      (signal) =>
        new Promise((resolve) => {
          seen.push(signal);
          setTimeout(() => resolve("value"), 50);
        }),
    );

    const { rerender } = render(<Probe fetcher={fetcher} deps={["a"]} />);
    await waitFor(() => expect(seen.length).toBe(1));

    rerender(<Probe fetcher={fetcher} deps={["b"]} />);
    await waitFor(() => expect(seen.length).toBe(2));

    expect(seen[0].aborted).toBe(true);
    expect(seen[1].aborted).toBe(false);
  });

  it("discards a slow response that lost the race", async () => {
    let resolveFirst;

    const fetcher = vi.fn(() => {
      if (fetcher.mock.calls.length === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve("second");
    });

    const { rerender } = render(<Probe fetcher={fetcher} deps={["a"]} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    rerender(<Probe fetcher={fetcher} deps={["b"]} />);
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("second"));

    // The stale winner arrives late and must not overwrite the newer value.
    await act(async () => {
      resolveFirst("first");
      await Promise.resolve();
    });

    expect(screen.getByTestId("data")).toHaveTextContent("second");
  });

  it("polls on an interval without flipping back to loading", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => "value");

    render(<Probe fetcher={fetcher} options={{ intervalMs: 1000 }} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    // A background refresh must not blank the screen.
    expect(screen.getByTestId("initial")).toHaveTextContent("false");
  });

  it("stops polling on unmount", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => "value");

    const { unmount } = render(<Probe fetcher={fetcher} options={{ intervalMs: 1000 }} />);

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
