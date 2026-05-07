export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  next();
}
