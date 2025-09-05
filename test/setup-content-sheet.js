const SheetsManager = require('../config/sheets');

async function setupContentSheet() {
  const sheetsManager = new SheetsManager();
  
  try {
    await sheetsManager.initialize();
    
    // Check if we have the right sheet structure
    console.log('Current Content_Archive headers:', sheetsManager.contentSheet.headerValues);
    
    // Create new sheet with proper structure for articles
    const articleSheet = await sheetsManager.doc.addSheet({
      title: 'Article_Archive',
      headerValues: [
        'ID', 'Date_Collected', 'Source', 'Title', 'URL', 
        'Published_Date', 'Summary', 'Used_In_Issue', 'Content_Hash', 
        'Relevance_Score', 'Segment_Tag'
      ]
    });
    
    console.log('Created Article_Archive sheet for storing scraped articles');
    
  } catch (error) {
    console.error('Setup error:', error.message);
  }
}

setupContentSheet();