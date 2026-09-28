/**
 * StreamFlix API - Cloudflare Worker + D1
 *
 * Required:
 *   D1 binding: DB -> streamflix-movies
 *   Secret: ADMIN_PASSWORD -> your private admin password
 *
 * Public:
 *   GET  /
 *   GET  /movies
 *   GET  /auth (requires X-Admin-Key)
 *
 * Admin:
 *   POST   /movies
 *   PUT    /movies/:id
 *   DELETE /movies/:id
 */

const ALLOWED_CATEGORIES = new Set(["A", "B", "C", "D", "E"]);
const MAX_LIMIT = 20000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}

function normalizeText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function requireAdmin(request, env) {
  const provided = request.headers.get("X-Admin-Key") || "";

  if (!env.ADMIN_PASSWORD || !provided || provided !== env.ADMIN_PASSWORD) {
    return false;
  }

  return true;
}

function movieFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    poster: row.poster,
    videoUrl: row.video_url,
    desc: row.description || "",
    date: row.date
  };
}

function validateMovieInput(body, isUpdate = false) {
  const title = normalizeText(body.title, 200);
  const category = normalizeText(body.category, 1);
  const poster = normalizeText(body.poster, 2048);
  const videoUrl = normalizeText(body.videoUrl, 2048);
  const desc = normalizeText(body.desc, 5000);

  if (!title) {
    return { error: "กรุณาระบุชื่อภาพยนตร์" };
  }

  if (!ALLOWED_CATEGORIES.has(category)) {
    return { error: "หมวดหมู่ไม่ถูกต้อง ต้องเป็น A, B, C, D หรือ E" };
  }

  if (!validHttpUrl(poster)) {
    return { error: "Poster URL ไม่ถูกต้อง ต้องเป็น http:// หรือ https://" };
  }

  if (!validHttpUrl(videoUrl)) {
    return { error: "Video URL ไม่ถูกต้อง ต้องเป็น http:// หรือ https://" };
  }

  return {
    title,
    category,
    poster,
    videoUrl,
    desc
  };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method.toUpperCase();

      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      // Health check
      if (method === "GET" && path === "/") {
        return json({
          ok: true,
          service: "StreamFlix API",
          database: "D1",
          time: new Date().toISOString()
        });
      }

      // Admin authentication check
      if (method === "GET" && path === "/auth") {
        if (!requireAdmin(request, env)) {
          return json(
            { error: "Unauthorized" },
            401
          );
        }

        return json({ ok: true });
      }

      // ------------------------------------------------------------
      // GET /movies
      // Optional:
      //   ?limit=20000
      //   ?offset=0
      //   ?category=A
      //   ?search=batman
      // ------------------------------------------------------------
      if (method === "GET" && path === "/movies") {
        const requestedLimit = Number.parseInt(
          url.searchParams.get("limit") || "20000",
          10
        );

        const requestedOffset = Number.parseInt(
          url.searchParams.get("offset") || "0",
          10
        );

        const limit = Math.min(
          Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 20000, 1),
          MAX_LIMIT
        );

        const offset = Math.max(
          Number.isFinite(requestedOffset) ? requestedOffset : 0,
          0
        );

        const category = normalizeText(
          url.searchParams.get("category") || "",
          1
        );

        const search = normalizeText(
          url.searchParams.get("search") || "",
          200
        );

        const conditions = [];
        const params = [];

        if (ALLOWED_CATEGORIES.has(category)) {
          conditions.push("category = ?");
          params.push(category);
        }

        if (search) {
          conditions.push("(title LIKE ? OR description LIKE ?)");
          const pattern = `%${search}%`;
          params.push(pattern, pattern);
        }

        const where = conditions.length
          ? `WHERE ${conditions.join(" AND ")}`
          : "";

        const statement = `
          SELECT id, title, category, poster, video_url, description, date
          FROM movies
          ${where}
          ORDER BY date DESC, created_at DESC
          LIMIT ? OFFSET ?
        `;

        params.push(limit, offset);

        const result = await env.DB
          .prepare(statement)
          .bind(...params)
          .all();

        return json({
          movies: (result.results || []).map(movieFromRow),
          limit,
          offset,
          count: result.results?.length || 0
        });
      }

      // Everything below this point changes the database.
      if (!requireAdmin(request, env)) {
        return json(
          { error: "Unauthorized: admin password required" },
          401
        );
      }

      // ------------------------------------------------------------
      // POST /movies
      // ------------------------------------------------------------
      if (method === "POST" && path === "/movies") {
        let body;

        try {
          body = await request.json();
        } catch {
          return json({ error: "Request body ต้องเป็น JSON" }, 400);
        }

        const validated = validateMovieInput(body);

        if (validated.error) {
          return json({ error: validated.error }, 400);
        }

        const id = crypto.randomUUID();
        const date = new Date().toISOString().slice(0, 10);

        await env.DB
          .prepare(`
            INSERT INTO movies
              (id, title, category, poster, video_url, description, date)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            id,
            validated.title,
            validated.category,
            validated.poster,
            validated.videoUrl,
            validated.desc,
            date
          )
          .run();

        const row = await env.DB
          .prepare(`
            SELECT id, title, category, poster, video_url, description, date
            FROM movies
            WHERE id = ?
          `)
          .bind(id)
          .first();

        return json(movieFromRow(row), 201);
      }

      // ------------------------------------------------------------
      // PUT /movies/:id
      // ------------------------------------------------------------
      if (method === "PUT" && path.startsWith("/movies/")) {
        const id = decodeURIComponent(path.slice("/movies/".length));

        if (!id) {
          return json({ error: "Movie ID ไม่ถูกต้อง" }, 400);
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json({ error: "Request body ต้องเป็น JSON" }, 400);
        }

        const validated = validateMovieInput(body, true);

        if (validated.error) {
          return json({ error: validated.error }, 400);
        }

        const existing = await env.DB
          .prepare("SELECT id FROM movies WHERE id = ?")
          .bind(id)
          .first();

        if (!existing) {
          return json({ error: "ไม่พบภาพยนตร์เรื่องนี้" }, 404);
        }

        await env.DB
          .prepare(`
            UPDATE movies
            SET title = ?,
                category = ?,
                poster = ?,
                video_url = ?,
                description = ?
            WHERE id = ?
          `)
          .bind(
            validated.title,
            validated.category,
            validated.poster,
            validated.videoUrl,
            validated.desc,
            id
          )
          .run();

        const row = await env.DB
          .prepare(`
            SELECT id, title, category, poster, video_url, description, date
            FROM movies
            WHERE id = ?
          `)
          .bind(id)
          .first();

        return json(movieFromRow(row));
      }

      // ------------------------------------------------------------
      // DELETE /movies/:id
      // ------------------------------------------------------------
      if (method === "DELETE" && path.startsWith("/movies/")) {
        const id = decodeURIComponent(path.slice("/movies/".length));

        if (!id) {
          return json({ error: "Movie ID ไม่ถูกต้อง" }, 400);
        }

        const result = await env.DB
          .prepare("DELETE FROM movies WHERE id = ?")
          .bind(id)
          .run();

        if (!result.meta?.changes) {
          return json({ error: "ไม่พบภาพยนตร์เรื่องนี้" }, 404);
        }

        return json({
          ok: true,
          id
        });
      }

      return json(
        { error: "Not Found" },
        404
      );

    } catch (error) {
      console.error("Worker error:", error);

      return json(
        {
          error: "Internal Server Error",
          message: error instanceof Error ? error.message : String(error)
        },
        500
      );
    }
  }
};
