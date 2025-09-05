const SheetsManager = require('../config/sheets');

async function checkColumns() {
  const sheetsManager = new SheetsManager();
  
  try {
    await sheetsManager.initialize();
    
    // Load headers
    await sheetsManager.contentSheet.loadHeaderRow();
    
    console.log('Actual column headers in Content_Archive:');
    sheetsManager.contentSheet.headerValues.forEach((header, i) => {
      console.log(`${i + 1}. ${header}`);
    });
    
    console.log(`\nTotal columns: ${sheetsManager.contentSheet.headerValues.length}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkColumns();