// Simple proxy server to mimic Vercel's routing locally
// Routes /api/* requests to FastAPI backend on port 8000
// Serves static files from root directory

const http = require("http");
const httpProxy = require("http-proxy");
const fs = require("fs");
const path = require("path");

const proxy = httpProxy.createProxyServer({});
const PORT = 3000;
const API_PORT = 8000;

// Opt-in reload support for the Live Server workflow — the "Run Dev Server"
// task sets LIVE_SERVER_RELOAD=1. Even then, only requests that arrive through
// Live Server's own proxy (which adds a Via header) get the client injected;
// direct hits on this port and ordinary runs are served untouched.
const LIVE_RELOAD_ENABLED = process.env.LIVE_SERVER_RELOAD === "1";

// Reloads the page when Live Server's file watcher broadcasts on its /ws
// endpoint. Local-only helper, never reaches production deploys.
const LIVE_RELOAD_SNIPPET = [
	"<script>",
	"(function () {",
	'  if (!("WebSocket" in window)) return;',
	'  var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");',
	"  ws.onmessage = function (e) {",
	'    if (e.data === "reload" || e.data === "refreshcss") location.reload();',
	"  };",
	"})();",
	"</script>",
].join("\n");

// MIME types for static files
const mimeTypes = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".gpx": "application/gpx+xml",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".eot": "application/vnd.ms-fontobject",
	".otf": "font/otf",
};

const server = http.createServer((req, res) => {
	// Route /projects/running-posture-analyser/analyse to FastAPI /analyse endpoint.
	if (req.url.startsWith("/projects/running-posture-analyser/analyse")) {
		console.log(
			`[PROXY] ${req.method} ${req.url} -> http://localhost:${API_PORT}/analyse`,
		);
		req.url = "/analyse";
		proxy.web(req, res, {
			target: `http://localhost:${API_PORT}`,
			changeOrigin: true,
		});
		return;
	}

	// Route the Biwa ride's API calls to its isolated dev runner (biwa-dev.py).
	// Only /projects/biwa-ride/api/biwa-* is forwarded, ahead of all other
	// routing; everything else on the site is untouched.
	if (req.url.startsWith("/projects/biwa-ride/api/")) {
		const apiPath = req.url.replace("/projects/biwa-ride/api/", "/api/");
		console.log(
			`[PROXY] ${req.method} ${req.url} -> http://localhost:${API_PORT}${apiPath}`,
		);
		req.url = apiPath;
		proxy.web(req, res, {
			target: `http://localhost:${API_PORT}`,
			changeOrigin: true,
		});
		return;
	}

	// Route Pacey's API calls to the FastAPI /race-goal/* endpoints. The app now
	// calls /pacey/api/*; the old /projects/pacey/api/* prefix is kept so a
	// cached page still works.
	if (
		req.url.startsWith("/pacey/api/") ||
		req.url.startsWith("/projects/pacey/api/")
	) {
		const apiPath = req.url.replace(
			/^\/(?:projects\/pacey|pacey)\/api\//,
			"/race-goal/",
		);
		console.log(
			`[PROXY] ${req.method} ${req.url} -> http://localhost:${API_PORT}${apiPath}`,
		);
		req.url = apiPath;
		proxy.web(req, res, {
			target: `http://localhost:${API_PORT}`,
			changeOrigin: true,
		});
		return;
	}

	// The old /projects/pacey page 301s to the app's real path, /pacey.
	if (req.url === "/projects/pacey" || req.url === "/projects/pacey/") {
		res.writeHead(301, { Location: "/pacey" });
		res.end();
		return;
	}

	// Serve static files. The query string is stripped first (e.g.
	// ?_cacheOverride=...), so it is never treated as part of the filename, then
	// the path is percent-decoded so filenames containing escaped characters
	// resolve — without this, '%20' is treated as literal text and the request
	// 404s even though the file exists.
	let reqPath;
	try {
		reqPath = decodeURIComponent(
			new URL(req.url, "http://localhost").pathname,
		);
	} catch (e) {
		// Malformed URL or escape sequence — fall back to the raw path.
		reqPath = req.url.split("?")[0];
	}
	let filePath = "." + reqPath;
	if (filePath === "./") {
		filePath = "./index.html";
	}

	// A directory serves its index.html (e.g. /pacey -> ./pacey/index.html).
	// A directory without an index.html falls through to the clean-URL check
	// instead of shadowing a sibling page — /articles resolves to articles.html.
	const isDirectory =
		fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
	const dirIndex = isDirectory ? path.join(filePath, "index.html") : null;
	if (dirIndex && fs.existsSync(dirIndex)) {
		filePath = dirIndex;
	}

	// Handle clean URLs (e.g., /about -> /about.html)
	if (!path.extname(filePath) && (!fs.existsSync(filePath) || isDirectory)) {
		const htmlPath = filePath + ".html";
		if (fs.existsSync(htmlPath)) {
			filePath = htmlPath;
		} else if (isDirectory) {
			// Directory with neither an index.html nor a .html sibling — keep the
			// missing-index path so the response stays a 404, not an EISDIR error.
			filePath = dirIndex;
		}
	}

	const extname = String(path.extname(filePath)).toLowerCase();
	const contentType = mimeTypes[extname] || "application/octet-stream";

	fs.readFile(filePath, (error, content) => {
		if (error) {
			if (error.code === "ENOENT") {
				res.writeHead(404, {
					"Content-Type": "text/html",
					"Cache-Control": "no-store",
				});
				res.end("<h1>404 Not Found</h1>", "utf-8");
			} else {
				res.writeHead(500, { "Cache-Control": "no-store" });
				res.end(`Server Error: ${error.code}`, "utf-8");
			}
		} else {
			// Opt-in reload client: requires the env flag AND a Via header, which
			// Live Server's proxy adds to forwarded requests. Direct hits on this
			// port get the file exactly as written.
			if (
				LIVE_RELOAD_ENABLED &&
				req.headers.via &&
				contentType === "text/html"
			) {
				const html = content.toString("utf-8");
				const bodyEnd = html.toLowerCase().lastIndexOf("</body>");
				if (bodyEnd !== -1) {
					content =
						html.slice(0, bodyEnd) +
						LIVE_RELOAD_SNIPPET +
						"\n" +
						html.slice(bodyEnd);
				}
			}
			// no-store so a reload always re-reads fresh CSS and HTML.
			res.writeHead(200, {
				"Content-Type": contentType,
				"Cache-Control": "no-store",
			});
			res.end(content, "utf-8");
		}
	});
});

proxy.on("error", (err, req, res) => {
	console.error("[PROXY ERROR]", err.message);
	res.writeHead(502, { "Content-Type": "text/plain" });
	res.end("Bad Gateway - Is the FastAPI server running on port 8000?");
});

server.listen(PORT, () => {
	console.log(`\n🚀 Development server running:`);
	console.log(`   Static site:               http://localhost:${PORT}`);
	console.log(`   API proxied from:          http://localhost:${API_PORT}`);
	console.log(
		`   Running posture analyser:  http://localhost:${PORT}/projects/running-posture-analyser`,
	);
	console.log(`   Pacey:                http://localhost:${PORT}/pacey`);
	console.log(`   (the old /projects/pacey 301s to /pacey)\n`);
});
