// sitemap.xml — без него /scan/<адрес> и /dev/<кошелёк> (бесплатные страницы, которые реально ищут в
// Google по тикеру и контракту) никак не подсказаны поисковику. Next.js строит /sitemap.xml из этого файла
// сам (App Router Metadata Files); recentScans() — уже публичный список последних сканов (api/scan/recent, mcp).
import type { MetadataRoute } from "next";
import { recentScans } from "@/lib/server/scan";
import { recentDevWallets } from "@/lib/server/scan-operators";

const SITE = process.env.PUBLIC_URL?.trim() || "https://crawlhive.xyz";

// Статичные страницы продукта, которые хотим в индексе. /my, /tg, /oauth/* — сессионные или приватные, их нет.
const STATIC_PATHS = [
  { path: "", priority: 1, freq: "hourly" as const },
  { path: "/radar", priority: 0.9, freq: "hourly" as const },
  { path: "/narratives", priority: 0.9, freq: "hourly" as const },
  { path: "/track", priority: 0.8, freq: "daily" as const },
  { path: "/replay", priority: 0.8, freq: "daily" as const },
  { path: "/launch", priority: 0.8, freq: "daily" as const },
  { path: "/brain", priority: 0.7, freq: "weekly" as const },
  { path: "/leaderboard", priority: 0.6, freq: "daily" as const },
  { path: "/market", priority: 0.6, freq: "daily" as const },
  { path: "/signals", priority: 0.6, freq: "daily" as const },
  { path: "/spawn", priority: 0.6, freq: "weekly" as const },
  { path: "/governance", priority: 0.4, freq: "weekly" as const },
  { path: "/agents", priority: 0.5, freq: "weekly" as const },
  { path: "/extension", priority: 0.5, freq: "weekly" as const },
  { path: "/extension/privacy", priority: 0.2, freq: "yearly" as const },
  { path: "/terms", priority: 0.2, freq: "yearly" as const },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const base: MetadataRoute.Sitemap = STATIC_PATHS.map(({ path, priority, freq }) => ({
    url: `${SITE}${path}`,
    lastModified: now,
    changeFrequency: freq,
    priority,
  }));
  // Последние сканы: конкретный тикер + контракт — именно то, что люди ищут в Google перед покупкой.
  const scans: MetadataRoute.Sitemap = recentScans().map((s) => ({
    url: `${SITE}/scan/${s.id}`,
    lastModified: new Date(s.at),
    changeFrequency: "daily",
    priority: 0.7,
  }));
  // Деверы, которых память видела: /dev/<кошелёк> тоже реально ищут по адресу, но раньше в sitemap не попадал.
  const devs: MetadataRoute.Sitemap = recentDevWallets().map((w) => ({
    url: `${SITE}/dev/${w}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.5,
  }));
  return [...base, ...scans, ...devs];
}
