import type { APIRoute } from "astro";

declare const process: {
  env: Record<string, string | undefined>;
};

type InboxItem = {
  content: string;
  source: string;
  createdAt: string;
};

const GIST_FILE_NAME = "inbox.json";

async function fetchGistItems(): Promise<InboxItem[]> {
  const env = (import.meta as any).env ?? {};
  const gistId = env.GIST_ID ?? process.env.GIST_ID;
  const ghToken = env.GH_TOKEN ?? process.env.GH_TOKEN;

  if (!gistId) throw new Error("Missing env var: GIST_ID");
  if (!ghToken) throw new Error("Missing env var: GH_TOKEN");

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${ghToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub Gist GET failed: ${res.status} ${text}`);
  }

  const gist = (await res.json()) as {
    files?: Record<string, { content?: string }>;
  };

  const file = gist.files?.[GIST_FILE_NAME];
  const raw = file?.content ?? "";
  if (!raw.trim()) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as InboxItem[];
  } catch {
    // 如果舊內容不是合法 JSON，就直接回傳空陣列避免整體服務掛掉
    return [];
  }
}

async function patchGistItems(items: InboxItem[]): Promise<InboxItem[]> {
  const env = (import.meta as any).env ?? {};
  const gistId = env.GIST_ID ?? process.env.GIST_ID;
  const ghToken = env.GH_TOKEN ?? process.env.GH_TOKEN;

  if (!gistId) throw new Error("Missing env var: GIST_ID");
  if (!ghToken) throw new Error("Missing env var: GH_TOKEN");

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${ghToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: {
        [GIST_FILE_NAME]: {
          content: JSON.stringify(items, null, 2),
        },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub Gist PATCH failed: ${res.status} ${text}`);
  }

  return items;
}

export const GET: APIRoute = async () => {
  try {
    const items = await fetchGistItems();
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};

export const POST: APIRoute = async ({ request }) => {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (!payload || typeof payload !== "object") {
    return new Response(JSON.stringify({ error: "Invalid body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const { content, source } = payload as {
    content?: unknown;
    source?: unknown;
  };

  if (typeof content !== "string" || !content.trim()) {
    return new Response(JSON.stringify({ error: "Missing/invalid content" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (typeof source !== "string" || !source.trim()) {
    return new Response(JSON.stringify({ error: "Missing/invalid source" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  try {
    const oldItems = await fetchGistItems();
    const newItem: InboxItem = {
      content,
      source,
      createdAt: new Date().toISOString(),
    };

    const updated = [newItem, ...oldItems];
    const result = await patchGistItems(updated);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};

export const DELETE: APIRoute = async ({ request }) => {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (!payload || typeof payload !== "object") {
    return new Response(JSON.stringify({ error: "Invalid body" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const { createdAt } = payload as {
    createdAt?: unknown;
  };

  if (typeof createdAt !== "string" || !createdAt.trim()) {
    return new Response(
      JSON.stringify({ error: "Missing/invalid createdAt" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  try {
    const oldItems = await fetchGistItems();
    const updated = oldItems.filter((it) => it.createdAt !== createdAt);
    const result = await patchGistItems(updated);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
