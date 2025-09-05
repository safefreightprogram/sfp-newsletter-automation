const SheetsManager = require('../config/sheets');

async function debugSheets() {
  const sheetsManager = new SheetsManager();
  
  try {
    console.log('Testing Google Sheets connection...');
    
    await sheetsManager.initialize();
    
    // Log sheet info
    console.log('Document title:', sheetsManager.doc.title);
    console.log('Document ID:', sheetsManager.doc.spreadsheetId);
    
    // List all sheets
    console.log('\nAvailable sheets:');
    Object.keys(sheetsManager.doc.sheetsByTitle).forEach(title => {
      console.log(`- ${title}`);
    });
    
    // Test the content sheet specifically
    if (sheetsManager.contentSheet) {
      console.log(`\nContent_Archive sheet:`)
      console.log(`- Row count: ${sheetsManager.contentSheet.rowCount}`);
      console.log(`- Column count: ${sheetsManager.contentSheet.columnCount}`);
      
      // Try to read a few rows
      const rows = await sheetsManager.contentSheet.getRows({ limit: 5 });
      console.log(`- Data rows: ${rows.length}`);
    }
    
  } catch (error) {
    console.error('Debug failed:', error);
  }
}

debugSheets();