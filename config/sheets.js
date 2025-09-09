const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const config = require('./config');

class SheetsManager {
  constructor() {
    this.spreadsheetId = config.sheets.spreadsheetId;
    this.doc = null;
    this.contentSheet = null;
  }

// Replace the initialize() method in your sheets.js with this Railway-compatible version:

async initialize() {
  try {
    console.log('📊 Connecting to Google Sheets...');
    
    // Use environment variables instead of file for Railway
    const credentials = {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY ? 
        process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : null
    };
    
    // Validate credentials
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('Missing Google Sheets credentials in environment variables. Please set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY');
    }
    
    // Create JWT auth
    const serviceAccountAuth = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
      ],
    });

    // Use spreadsheet ID from config or environment
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID || this.spreadsheetId;
    if (!spreadsheetId) {
      throw new Error('Missing GOOGLE_SHEETS_ID in environment variables');
    }

    // Initialize document
    // Initialize document & authenticate
this.doc = new GoogleSpreadsheet(spreadsheetId);
await serviceAccountAuth.authorize();                 // ensure JWT is authorized
await this.doc.useOAuth2Client(serviceAccountAuth);   // attach authorized client
await this.doc.loadInfo();

    
    console.log(`✅ Connected to: ${this.doc.title}`);
    
    // Get the Article_Archive sheet
    this.contentSheet = this.doc.sheetsByTitle['Article_Archive'];
    if (!this.contentSheet) {
      console.log('📄 Creating Article_Archive sheet...');
      this.contentSheet = await this.doc.addSheet({
        title: 'Article_Archive',
        headerValues: ['ID', 'Date_Collected', 'Source', 'Title', 'URL', 'Published_Date', 'Summary', 'Used_In_Issue', 'Content_Hash', 'Relevance_Score', 'Segment_Tag']
      });
    }
    
    await this.contentSheet.loadHeaderRow();
    console.log(`✅ Article_Archive sheet ready (${this.contentSheet.rowCount - 1} existing rows)`);
    
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to Google Sheets:', error.message);
    return false;
  }
}      
     
  async getExistingHashes() {
    try {
      const rows = await this.contentSheet.getRows();
      return rows.map(row => row.get('Content_Hash')).filter(Boolean);
    } catch (error) {
      console.log('No existing hashes found or error reading:', error.message);
      return [];
    }
  }

  async saveArticles(articles) {
    try {
      console.log(`💾 Saving ${articles.length} articles to Google Sheets...`);
      
      // Get existing content hashes to avoid duplicates
      const existingHashes = await this.getExistingHashes();
      console.log(`📋 Found ${existingHashes.length} existing articles in database`);
      
      const newArticles = [];
      const duplicates = [];
      
      for (const article of articles) {
        const hash = this.generateHash(article.title + article.url);
        
        if (existingHashes.includes(hash)) {
          duplicates.push(article.title);
          continue;
        }
        
        const rowData = {
          ID: `ARTICLE-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          Date_Collected: new Date().toISOString(),
          Source: article.source,
          Title: article.title,
          URL: article.url,
          Published_Date: article.publishedDate.toISOString(),
          Summary: article.summary,
          Used_In_Issue: '',
          Content_Hash: hash,
          Relevance_Score: article.relevanceScore,
          Segment_Tag: this.determineSegmentTag(article)
        };
        
        newArticles.push(rowData);
      }
      
      if (duplicates.length > 0) {
        console.log(`🔄 Skipped ${duplicates.length} duplicate articles`);
      }
      
      if (newArticles.length === 0) {
        console.log('ℹ️  No new articles to save (all were duplicates)');
        return [];
      }
      
      // Add rows to sheet
      await this.contentSheet.addRows(newArticles);
      
      console.log(`✅ Successfully saved ${newArticles.length} new articles to Google Sheets`);
      
      // Log summary
      const highQuality = newArticles.filter(a => a.Relevance_Score > 10).length;
      const proSegment = newArticles.filter(a => a.Segment_Tag === 'pro').length;
      const driverSegment = newArticles.filter(a => a.Segment_Tag === 'driver').length;
      const bothSegment = newArticles.filter(a => a.Segment_Tag === 'both').length;
      
      console.log(`📈 Quality breakdown:`);
      console.log(`   ⭐ High relevance (>10): ${highQuality}`);
      console.log(`   💼 Professional segment: ${proSegment}`);
      console.log(`   🚛 Driver segment: ${driverSegment}`);
      console.log(`   🎯 Both segments: ${bothSegment}`);
      
      return newArticles;

    } catch (error) {
      console.error('❌ Failed to save articles:', error.message);
      throw error;
    }
  }

  generateHash(content) {
    // Simple hash function for content deduplication
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  determineSegmentTag(article) {
    const content = (article.title + ' ' + article.summary).toLowerCase();
    
    const proTerms = [
      'compliance', 'enforcement', 'legal', 'audit', 'penalty', 'court', 
      'regulation', 'nhvr', 'accreditation', 'prosecution', 'fine',
      'chain of responsibility', 'cor', 'hvnl'
    ];
    
    const driverTerms = [
      'safety', 'driver', 'fatigue', 'maintenance', 'inspection', 'tips', 
      'practical', 'vehicle check', 'roadworthy', 'brake', 'tyre'
    ];
    
    const proScore = proTerms.reduce((score, term) => 
      content.includes(term) ? score + 1 : score, 0);
    const driverScore = driverTerms.reduce((score, term) => 
      content.includes(term) ? score + 1 : score, 0);
    
    if (proScore > driverScore + 1) return 'pro';
    if (driverScore > proScore + 1) return 'driver';
    return 'both';
  }

  async getRecentArticles(days = 7, segment = null) {
    try {
      console.log(`📋 Fetching recent articles (${days} days, segment: ${segment || 'all'})...`);
      
      const rows = await this.contentSheet.getRows();
      console.log(`📊 Total rows in Article_Archive: ${rows.length}`);
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);
      console.log(`🗓️  Looking for articles newer than: ${cutoffDate.toISOString()}`);
      
      const recentArticles = [];
      
      for (const row of rows) {
        const published = row.get('Published_Date') ? new Date(row.get('Published_Date')) : null;
const collected = row.get('Date_Collected') ? new Date(row.get('Date_Collected')) : null;
const chosenDate = published || collected;  // prefer published
const isRecent = chosenDate ? chosenDate >= cutoffDate : false;

        const isUnused = !row.get('Used_In_Issue') || row.get('Used_In_Issue') === '';
        const rowSegmentTag = (row.get('Segment_Tag') || '').toLowerCase();
const seg = (segment || '').toLowerCase();
const segmentMatch = !seg || rowSegmentTag === 'both' || rowSegmentTag === seg || rowSegmentTag.includes(seg); // matches 'pro-2025-09-04'

        
        if (isRecent && isUnused && segmentMatch) {
          recentArticles.push({
            id: row.get('ID'),
            title: row.get('Title'),
            url: row.get('URL'),
            source: row.get('Source'),
            summary: row.get('Summary'),
            relevanceScore: parseFloat(row.get('Relevance_Score')) || 0,
            segmentTag: rowSegmentTag
          });
        }
      }
      
      // Sort by relevance score
      recentArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);
      
      console.log(`✅ Found ${recentArticles.length} matching articles`);
      
      return recentArticles;
    } catch (error) {
      console.error('Error fetching recent articles:', error.message);
      return [];
    }
  }

  async checkIfArticleExists(url, title) {
    try {
      const rows = await this.contentSheet.getRows();
      const titleKey = title.toLowerCase().trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ');
      
      for (const row of rows) {
        const existingUrl = row.get('URL');
        const existingTitle = (row.get('Title') || '').toLowerCase().trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ');
        
        // Exact URL match
        if (existingUrl === url) return true;
        
        // Title similarity check
        if (this.calculateSimilarity(titleKey, existingTitle) > 0.85) return true;
      }
      
      return false;
    } catch (error) {
      console.error('Error checking article existence:', error.message);
      return false;
    }
  }

  calculateSimilarity(str1, str2) {
    const set1 = new Set(str1.split(' ').filter(w => w.length > 3));
    const set2 = new Set(str2.split(' ').filter(w => w.length > 3));
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  async markArticlesAsUsed(articleIds, issueId) {
    try {
      console.log(`🏷️ Marking ${articleIds.length} articles as used in ${issueId}`);
      
      const rows = await this.contentSheet.getRows();
      let updatedCount = 0;
      
      for (const row of rows) {
        const rowId = row.get('ID');
        if (articleIds.includes(rowId)) {
          row.set('Used_In_Issue', issueId);
          await row.save();
          updatedCount++;
          console.log(`  ✅ Marked: ${row.get('Title').substring(0, 50)}...`);
        }
      }
      
      console.log(`✅ Successfully marked ${updatedCount} articles as used`);
      return updatedCount;
    } catch (error) {
      console.error('❌ Error marking articles as used:', error.message);
      return 0;
    }
  }

  async logNewsletterToArchive(newsletterData) {
    try {
      let sheet = this.doc.sheetsByTitle['Content_Archive'];
if (!sheet) {
  sheet = await this.doc.addSheet({
    title: 'Content_Archive',
    headerValues: [
      'Issue_ID','Segment','Subject','Published_At',
      'Sent_Count','Failed_Count','Open_Rate','Click_Rate','Content_JSON'
    ],
  });
}

await sheet.addRow({
  Issue_ID:     newsletterData.issue_id,
  Segment:      newsletterData.segment,
  Subject:      newsletterData.subject,
  Published_At: newsletterData.published_at,
  Sent_Count:   newsletterData.sent_count,
  Failed_Count: newsletterData.failed_count,
  Open_Rate:    newsletterData.open_rate,
  Click_Rate:   newsletterData.click_rate,
  Content_JSON: newsletterData.content_json,
});

      return true;
    } catch (error) {
      console.error('Error logging newsletter to archive:', error.message);
      return false;
    }
  }
}

module.exports = SheetsManager;