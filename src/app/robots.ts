// robots.txt — без него поисковики не знают про sitemap и обходят /api, /oauth, /my и панели как обычные
// страницы. Next.js строит /robots.txt из этого файла сам (App Router Metadata Files).
import type { MetadataRoute } from "next";

const SITE = process.env.PUBLIC_URL?.trim() || "https://crawlhive.xyz";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/oauth/", "/my", "/tg/admin", "/.well-known/mcp-registry-auth", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"],
      },
    ],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
