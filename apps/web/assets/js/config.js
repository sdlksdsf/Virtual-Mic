/* VoxBridge public configuration.
 *
 * Only publishable values belong here: the Supabase URL and the publishable
 * (anon) key. Row level security limits both to inserts on `feedback` and
 * `download_events` plus the `download_counts` RPC. No service keys, ever.
 */
window.VOXBRIDGE_CONFIG = {
  supabaseUrl: 'https://rlmrgjxvuddexupkobpc.supabase.co',
  supabaseAnonKey: 'sb_publishable_Rx3oyuq56eAo7b_xxWrUaw_LKQKXA59',
  supportEmail: 'hello@voxbridge.app',
  securityEmail: 'security@voxbridge.app',
  privacyEmail: 'privacy@voxbridge.app',
  version: '1.0.0',
};
