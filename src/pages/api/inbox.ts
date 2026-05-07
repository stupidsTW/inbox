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

function getEnv() {
  return (import.meta as any).env ?? {};
}

function getSecretPass() {
  const env = getEnv();
  const passRaw = (env.PASS ?? process.env.PASS) as unknown;
  if (typeof passRaw !== "string") return undefined;

  let pass = passRaw.trim();
  if (
    (pass.startsWith('"') && pass.endsWith('"')) ||
    (pass.startsWith("'") && pass.endsWith("'"))
  ) {
    pass = pass.slice(1, -1).trim();
  }

  return pass ? pass : undefined;
}

function getAppsScriptUrl() {
  const env = getEnv();
  const urlRaw = (env.APPS_SCRIPT_URL ?? process.env.APPS_SCRIPT_URL) as
    | string
    | undefined;
  if (typeof urlRaw !== "string") return undefined;
  const url = urlRaw.trim();
  return url ? url : undefined;
}

function normalizeItems(payload: unknown): InboxItem[] {
  // apps script could return:
  // 1) array
  // 2) { items: [...] }
  // 3) { inbox: [...] }
  if (Array.isArray(payload)) return payload as InboxItem[];
  if (payload && typeof payload === "object") {
    const obj = payload as any;
    if (Array.isArray(obj.items)) return obj.items as InboxItem[];
    if (Array.isArray(obj.inbox)) return obj.inbox as InboxItem[];
  }
  return [];
}

async function callAppsScript(action: string, params: Record<string, string>) {
  const appsUrl = getAppsScriptUrl();
  if (!appsUrl) throw new Error("Missing env var: APPS_SCRIPT_URL");

  const body = new URLSearchParams({
    action,
    ...params,
  }).toString();

  const res = await fetch(appsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "application/json",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apps Script call failed: ${res.status} ${text}`);
  }

  // Sometimes Apps Script returns a JSON string; handle both.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = await res.json().catch(() => null);
    return normalizeItems(data);
  }

  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return normalizeItems(parsed);
  } catch {
    return [];
  }
}

async function fetchGistItems(): Promise<InboxItem[]> {
  const env = getEnv();
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
    return [];
  }
}

async function patchGistItems(items: InboxItem[]): Promise<InboxItem[]> {
  const env = getEnv();
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
    if (getAppsScriptUrl()) {
      const items = await callAppsScript("get", {});
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Backend": "apps-script",
        },
      });
    }

    const items = await fetchGistItems();
    return new Response(JSON.stringify(items), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Backend": "gist",
      },
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

  const { content, source, pass } = payload as {
    content?: unknown;
    source?: unknown;
    pass?: unknown;
  };

  const secretPass = getSecretPass();
  if (!secretPass) {
    const env = getEnv();
    return new Response(
      JSON.stringify({
        error: "Server misconfigured",
        hasEnvPass: typeof env.PASS === "string" && env.PASS.trim().length > 0,
        hasProcessPass:
          typeof process.env.PASS === "string" &&
          process.env.PASS.trim().length > 0,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  if (typeof pass !== "string" || !pass.trim()) {
    return new Response(JSON.stringify({ error: "Missing/invalid pass" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (pass !== secretPass) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

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

  const appsUrl = getAppsScriptUrl();
  try {
    if (appsUrl) {
      const items = await callAppsScript("add", {
        content,
        source,
        pass: pass,
      });
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Backend": "apps-script",
        },
      });
    }

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
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Backend": "gist",
      },
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

  const { createdAt, pass } = payload as {
    createdAt?: unknown;
    pass?: unknown;
  };

  const secretPass = getSecretPass();
  if (!secretPass) {
    const env = getEnv();
    return new Response(
      JSON.stringify({
        error: "Server misconfigured",
        hasEnvPass: typeof env.PASS === "string" && env.PASS.trim().length > 0,
        hasProcessPass:
          typeof process.env.PASS === "string" &&
          process.env.PASS.trim().length > 0,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  if (typeof pass !== "string" || !pass.trim()) {
    return new Response(JSON.stringify({ error: "Missing/invalid pass" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (pass !== secretPass) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (typeof createdAt !== "string" || !createdAt.trim()) {
    return new Response(
      JSON.stringify({ error: "Missing/invalid createdAt" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  const appsUrl = getAppsScriptUrl();
  try {
    if (appsUrl) {
      const items = await callAppsScript("delete", {
        createdAt: createdAt,
        pass: pass,
      });
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Backend": "apps-script",
        },
      });
    }

    const oldItems = await fetchGistItems();
    const updated = oldItems.filter((it) => it.createdAt !== createdAt);
    const result = await patchGistItems(updated);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Backend": "gist",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
