import type { MetadataRoute } from 'next'
import { sitemapPages, siteUrl } from '@/lib/site'

export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl()
  return sitemapPages().map((entry) => ({
    url: new URL(entry.path, base).toString(),
    changeFrequency: 'weekly',
    priority: entry.priority
  }))
}
