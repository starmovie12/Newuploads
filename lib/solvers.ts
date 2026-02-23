import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Native Node.js implementation of the hblinks.dad solver.
 */
export async function solveHBLinks(url: string) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    };

    const response = await axios.get(url, { headers, timeout: 15000 });

    if (response.status !== 200) {
      return { status: "fail", message: `Cannot open page. Status: ${response.status}` };
    }

    const $ = cheerio.load(response.data);
    
    const hubcloudLink = $('a[href*="hubcloud.foo"]').attr('href');
    if (hubcloudLink) {
      return { status: "success", link: hubcloudLink, source: "HubCloud (Priority 1)" };
    }
        
    const hubdriveLink = $('a[href*="hubdrive.space"]').attr('href');
    if (hubdriveLink) {
      return { status: "success", link: hubdriveLink, source: "HubDrive (Priority 2)" };
    }
        
    return { status: "fail", message: "Not Found" };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

/**
 * Junk link text patterns to filter out - case insensitive matching
 */
const JUNK_LINK_TEXTS = [
  "how to download",
  "[how to download]",
  "how to watch",
  "[how to watch]",
  "join telegram",
  "join our telegram",
  "request movie",
];

/**
 * Checks if a link's text or nearby text is a junk/tutorial link
 */
function isJunkLink(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return JUNK_LINK_TEXTS.some(junk => lower.includes(junk));
}

/**
 * Extract movie preview info: title + poster image
 */
export function extractMoviePreview(html: string): { title: string; posterUrl: string | null } {
  const $ = cheerio.load(html);

  // Title: Try <h1> first, then og:title, then <title>
  let title = '';
  const h1 = $('h1.entry-title, h1.post-title, h1').first().text().trim();
  if (h1) {
    title = h1;
  } else {
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    title = ogTitle || $('title').text().trim() || 'Unknown Movie';
  }
  // Clean title - remove site name suffixes
  title = title.replace(/\s*[-–|].*?(HDHub|HdHub|hdhub|Download|Free).*$/i, '').trim();

  // Poster: Try og:image, then first big image in entry-content
  let posterUrl: string | null = null;
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage && !ogImage.includes('logo') && !ogImage.includes('favicon')) {
    posterUrl = ogImage;
  } else {
    const contentImg = $('.entry-content img, .post-content img, main img').first().attr('src');
    if (contentImg && !contentImg.includes('logo') && !contentImg.includes('icon')) {
      posterUrl = contentImg;
    }
  }

  return { title, posterUrl };
}

/**
 * Native Node.js implementation of the movie link extractor.
 * With strict junk link filter for "[How To Download]" etc.
 */
export async function extractMovieLinks(url: string) {
  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    "Referer": "https://hdhub4u.fo/"
  };

  const JUNK_DOMAINS = ["catimages", "imdb.com", "googleusercontent", "instagram.com", "facebook.com", "wp-content", "wpshopmart"];

  try {
    const response = await fetch(url, { headers: HEADERS });
    const html = await response.text();
    const $ = cheerio.load(html);

    const foundLinks: { name: string; link: string }[] = [];
    
    // Extract Metadata using enhanced Python-ported function
    const metadata = extractMovieMetadata(html);
    
    // Extract movie preview (title + poster)
    const preview = extractMoviePreview(html);

    // Optimized Extraction: Target download-related elements directly
    $('.entry-content a[href], main a[href]').each((_idx: number, el: any) => {
      const $a = $(el);
      const link = $a.attr('href') || '';
      const text = $a.text().trim();
      
      // Filter out junk domains immediately
      if (!link || link.startsWith('#') || JUNK_DOMAINS.some(junk => link.includes(junk))) return;
      
      // ===== STRICT JUNK LINK FILTER =====
      // Check the link text itself
      if (isJunkLink(text)) return;
      
      // Check parent element text for junk patterns
      const $parent = $a.closest('p, div, h3, h4');
      const parentText = $parent.text().trim();
      if (isJunkLink(parentText)) return;
      
      // Check for known solver domains or download keywords
      const isTargetDomain = ["hblinks", "hubdrive", "hubcdn", "hubcloud", "gdflix", "drivehub"].some(d => link.includes(d));
      const isDownloadText = ["DOWNLOAD", "720P", "480P", "1080P", "4K", "DIRECT", "GDRIVE"].some(t => text.toUpperCase().includes(t));

      if (isTargetDomain || isDownloadText) {
        if (!foundLinks.some(x => x.link === link)) {
          let cleanName = text.replace(/⚡/g, "").trim();
          if (!cleanName || cleanName.length < 2) {
            const parent = $a.closest('p, div, h3, h4');
            const prev = parent.prev('h3, h4, h5, strong');
            cleanName = prev.text().trim() || parent.text().trim() || "Download Link";
          }
          
          // Double-check the resolved name isn't junk either
          if (!isJunkLink(cleanName)) {
            foundLinks.push({ name: cleanName.substring(0, 50), link: link });
          }
        }
      }
    });

    if (foundLinks.length === 0) {
      return { status: "error", message: "No links found. The page structure might have changed." };
    }

    return { 
      status: "success", 
      total: foundLinks.length, 
      links: foundLinks, 
      metadata,
      preview
    };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

/**
 * ============================================================
 * ENHANCED Movie Metadata Extractor
 * Ported from Python script with 6-step extraction strategy:
 * - Step 1: Find main content area
 * - Step 2: Find DOWNLOAD LINKS section
 * - Step 3: Extract from download button labels
 * - Step 4: Check for MULTi audio line
 * - Step 5: Fallback Language: field
 * - Step 6: Quality fallback from description
 * ============================================================
 */
export function extractMovieMetadata(html: string): {
  quality: string;
  languages: string;
  audioLabel: string;
} {
  const $ = cheerio.load(html);

  const validLangs = [
    'Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam',
    'Kannada', 'Punjabi', 'Marathi', 'Bengali', 'Spanish',
    'French', 'Korean', 'Japanese', 'Chinese'
  ];

  const foundLanguages = new Set<string>();
  const qualityInfo = { resolution: '', format: '' };

  // Format priority scores (higher = better)
  const formatPriority: Record<string, number> = {
    'WEB-DL': 5,
    'BluRay': 4,
    'WEBRip': 3,
    'HEVC': 2,
    'x264': 1,
    'HDTC': 0,
    '10Bit': 0
  };

  // ===== STEP 1: Find the main content area =====
  // FIXED TYPE ERROR HERE BY ADDING `: any`
  let $mainContent: any = $('main.page-body');
  if ($mainContent.length === 0) $mainContent = $('div.entry-content');
  if ($mainContent.length === 0) $mainContent = $.root();

  // ===== STEP 2: Look for the "DOWNLOAD LINKS" section =====
  let $downloadSection: ReturnType<typeof $> | null = null;
  $mainContent.find('h2, h3, h4').each((_i: number, heading: any) => {
    const headingText = $(heading).text().toUpperCase();
    if (headingText.includes('DOWNLOAD LINKS')) {
      $downloadSection = $(heading).parent();
      return false; // break
    }
  });
  if (!$downloadSection) $downloadSection = $mainContent;

  // ===== STEP 3: Extract from download button labels =====
  const downloadLinks = ($downloadSection as ReturnType<typeof $>).find('a[href]');

  downloadLinks.each((_i, el) => {
    const href = $(el).attr('href') || '';

    // Only process actual download links (known CDN domains)
    const cdnDomains = ['hubcdn', 'hubdrive', 'gadgetsweb', 'hubstream', 'hdstream', 'hblinks', 'hubcloud', 'gdflix', 'drivehub'];
    if (!cdnDomains.some(d => href.toLowerCase().includes(d))) return;

    // Get the parent heading/element text which contains quality + language
    const $parent = $(el).closest('h3, h4, p');
    const buttonLabel = $parent.length ? $parent.text().trim() : $(el).text().trim();

    // Extract languages
    for (const lang of validLangs) {
      const regex = new RegExp(`\\b${lang}\\b`, 'i');
      if (regex.test(buttonLabel)) {
        foundLanguages.add(lang);
      }
    }

    // Extract quality - highest resolution wins
    const qualityMatch = buttonLabel.match(/(480p|720p|1080p|2160p|4K)/i);
    if (qualityMatch) {
      const res = qualityMatch[1].toUpperCase();
      const currentResVal = parseInt((qualityInfo.resolution.replace(/\D/g, '') || '0'), 10);
      const newResVal = parseInt((res.replace(/\D/g, '') || '0'), 10);
      if (newResVal > currentResVal) {
        qualityInfo.resolution = res;
      }
    }

    // Extract format with priority
    const formatPatterns: [RegExp, string][] = [
      [/WEB-DL/i, 'WEB-DL'],
      [/BLURAY|BLU-RAY/i, 'BluRay'],
      [/WEBRIP|WEB-RIP/i, 'WEBRip'],
      [/HDTC|HD-TC/i, 'HDTC'],
      [/HEVC|H\.265|x265/i, 'HEVC'],
      [/x264|H\.264/i, 'x264'],
      [/10[- ]?Bit/i, '10Bit'],
    ];

    for (const [pattern, formatName] of formatPatterns) {
      if (pattern.test(buttonLabel)) {
        const currentPriority = formatPriority[qualityInfo.format] ?? -1;
        const newPriority = formatPriority[formatName] ?? -1;
        if (newPriority > currentPriority) {
          qualityInfo.format = formatName;
        }
        break;
      }
    }
  });

  // ===== STEP 4: Check for MULTi audio line =====
  const pageText = ($downloadSection as ReturnType<typeof $>).text();
  const multiMatch = pageText.match(/MULTi.*?\[(.*?HINDI.*?)\]/is);
  if (multiMatch) {
    const langString = multiMatch[1];
    for (const lang of validLangs) {
      const regex = new RegExp(`\\b${lang}\\b`, 'i');
      if (regex.test(langString)) {
        foundLanguages.add(lang);
      }
    }
  }

  // ===== STEP 5: Fallback - Check Language: field in description =====
  if (foundLanguages.size === 0) {
    $mainContent.find('div, span, p').each((_i: number, elem: any) => {
      const text = $(elem).text();
      const langFieldMatch = text.match(/Language\s*:(.+?)(?:\n|\/|$)/i);
      if (langFieldMatch) {
        const langLine = langFieldMatch[1];
        for (const lang of validLangs) {
          const regex = new RegExp(`\\b${lang}\\b`, 'i');
          if (regex.test(langLine)) {
            foundLanguages.add(lang);
          }
        }
        return false; // break
      }
    });
  }

  // ===== STEP 6: Quality fallback from description =====
  if (!qualityInfo.resolution) {
    $mainContent.find('div, span, p').each((_i: number, elem: any) => {
      const text = $(elem).text();
      if (/Quality\s*:/i.test(text)) {
        const qualityMatch = text.match(/Quality\s*:(.+?)(?:\n|$)/i);
        if (qualityMatch) {
          const qualityLine = qualityMatch[1];

          const resMatch = qualityLine.match(/(480p|720p|1080p|2160p|4K)/i);
          if (resMatch) {
            qualityInfo.resolution = resMatch[1].toUpperCase();
          }

          const fallbackFormatPatterns: [RegExp, string][] = [
            [/WEB-DL/i, 'WEB-DL'],
            [/BLURAY|BLU-RAY/i, 'BluRay'],
            [/WEBRIP|WEB-RIP/i, 'WEBRip'],
            [/HDTC|HD-TC/i, 'HDTC'],
            [/HEVC|H\.265|x265/i, 'HEVC'],
            [/x264|H\.264/i, 'x264'],
          ];

          for (const [pattern, formatName] of fallbackFormatPatterns) {
            if (pattern.test(qualityLine)) {
              qualityInfo.format = formatName;
              break;
            }
          }
        }
        return false; // break
      }
    });
  }

  // ===== Audio Label Logic =====
  const langList = Array.from(foundLanguages).sort();
  const count = langList.length;

  let audioLabel = 'Not Found';
  if (count === 1) {
    audioLabel = langList[0];
  } else if (count === 2) {
    audioLabel = 'Dual Audio';
  } else if (count >= 3) {
    audioLabel = 'Multi Audio';
  }

  // Build final quality string
  let finalQuality = 'Unknown Quality';
  if (qualityInfo.resolution) {
    finalQuality = `${qualityInfo.resolution} ${qualityInfo.format}`.trim();
  }

  return {
    quality: finalQuality,
    languages: langList.length > 0 ? langList.join(', ') : 'Not Specified',
    audioLabel: audioLabel
  };
}

/**
 * Native Node.js implementation of HubCDN Bypass.
 */
export async function solveHubCDN(url: string) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
  };

  try {
    let targetUrl = url;

    if (!url.includes("/dl/")) {
      const resp = await axios.get(url, { headers, timeout: 15000 });
      const html = resp.data;
      
      const reurlMatch = html.match(/var reurl = "(.*?)"/);
      if (reurlMatch) {
        const redirectUrl = reurlMatch[1];
        const urlObj = new URL(redirectUrl);
        const rParam = urlObj.searchParams.get('r');
        
        if (rParam) {
          const paddedB64 = rParam + "=".repeat((4 - rParam.length % 4) % 4);
          targetUrl = Buffer.from(paddedB64, 'base64').toString('utf-8');
        }
      }
    }

    const finalResp = await axios.get(targetUrl, { headers, timeout: 20000 });
    const $ = cheerio.load(finalResp.data);
    
    const linkTag = $('a#vd');
    const finalLink = linkTag.attr('href');

    if (finalLink) {
      return { status: "success", final_link: finalLink };
    }

    const scriptMatch = finalResp.data.match(/window\.location\.href\s*=\s*"(.*?)"/);
    if (scriptMatch) {
      return { status: "success", final_link: scriptMatch[1] };
    }

    return { status: "failed", message: "Link id='vd' not found in HTML" };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}

/**
 * Native Node.js implementation of HubDrive solver.
 */
export async function solveHubDrive(url: string) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://hdhub4u.fo/"
  };

  try {
    const response = await axios.get(url, { headers, timeout: 15000 });
    const $ = cheerio.load(response.data);

    let finalLink = "";

    const btnSuccess = $('a.btn-success[href*="hubcloud"]');
    if (btnSuccess.length > 0) {
      finalLink = btnSuccess.attr('href') || "";
    }

    if (!finalLink) {
      const dlBtn = $('a#dl');
      if (dlBtn.length > 0) {
        finalLink = dlBtn.attr('href') || "";
      }
    }

    if (!finalLink) {
      $('a[href]').each((_i: number, el: any) => {
        const href = $(el).attr('href') || "";
        if (href.includes('hubcloud') || href.includes('hubcdn')) {
          finalLink = href;
          return false;
        }
      });
    }

    if (finalLink) {
      return { status: "success", link: finalLink };
    }

    return { status: "fail", message: "Download link not found on HubDrive page" };

  } catch (e: any) {
    return { status: "error", message: e.message };
  }
}
