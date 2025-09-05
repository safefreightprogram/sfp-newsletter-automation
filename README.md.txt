# SFP Newsletter Automation

Automated newsletter system for Safe Freight Program - scrapes Australian transport industry news and generates weekly newsletters.

## Features

- ✅ Automated content scraping from Australian transport news sources
- ✅ AI-powered newsletter generation
- ✅ Google Sheets integration for subscriber management
- ✅ Automated email distribution
- ✅ Analytics tracking
- ✅ Railway deployment ready

## Quick Start

### Local Development

1. Clone repository
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and configure
4. Run: `npm start`

### Manual Operations

- Scrape content: `npm run scrape`
- Generate newsletter: `npm run generate`
- Test system: `npm run test`

## API Endpoints

- `GET /health` - Health check
- `POST /api/scrape` - Manual content scraping
- `POST /api/generate` - Manual newsletter generation
- `GET /api/status` - System status
- `GET /unsubscribe?email=` - Unsubscribe endpoint

## Deployment

Deployed on Railway.app with automated weekly scheduling:
- Scraping: Mondays 6 AM AEST
- Newsletter: Mondays 8 AM AEST

## Environment Variables

See `.env.example` for required configuration.

## Support

Safe Freight Program Newsletter Automation
Contact: support@safefreightprogram.com