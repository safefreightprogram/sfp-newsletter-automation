export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const email = url.searchParams.get('email');
  const segment = url.searchParams.get('segment');
  const token = url.searchParams.get('token');

  // Simple token validation (in production, use proper JWT)
  const expectedToken = btoa(`${email}-${segment}-${env.UNSUBSCRIBE_SECRET || 'default-secret'}`);
  
  if (token !== expectedToken) {
    return new Response('Invalid unsubscribe link', { status: 400 });
  }

  try {
    // Call GAS unsubscribe endpoint
    const gasUrl = env.GAS_NEWSLETTER_URL || 'your-gas-url';
    
    await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        action: action === 'pause' ? 'newsletter_pause' : 'newsletter_unsubscribe',
        email: email,
        segment: segment || 'all'
      })
    });

    // Show success page
    return new Response(`
<!DOCTYPE html>
<html>
<head>
    <title>${action === 'pause' ? 'Subscription Paused' : 'Unsubscribed'} - Safe Freight Program</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
        .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 20px; border-radius: 8px; }
        .logo { width: 60px; height: auto; margin-bottom: 20px; }
    </style>
</head>
<body>
    <img src="https://safefreightprogram.com/images/sfp-logo.png" alt="Safe Freight Program" class="logo">
    <div class="success">
        <h2>${action === 'pause' ? 'Subscription Paused' : 'Successfully Unsubscribed'}</h2>
        <p>${action === 'pause' 
          ? 'Your Safe Freight Program newsletter subscription has been paused. You can resubscribe at any time.' 
          : 'You have been successfully unsubscribed from Safe Freight Program newsletters.'}</p>
        <p>This action complies with the Australian Spam Act 2003.</p>
        <a href="https://safefreightprogram.com" style="color: #1e40af;">Return to Website</a>
    </div>
</body>
</html>
    `, { 
      headers: { 'Content-Type': 'text/html' },
      status: 200 
    });

  } catch (error) {
    return new Response('Error processing request', { status: 500 });
  }
}