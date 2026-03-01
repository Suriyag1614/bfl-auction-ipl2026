const SUPABASE_URL = 'https://gqltwhcxrcwtsamfqvuw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdxbHR3aGN4cmN3dHNhbWZxdnV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNzU0MDIsImV4cCI6MjA4NzY1MTQwMn0.1TgJE59VIX9eIzjw3amxcJCLdZnqVPFwfrj-HqY-1-4';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window._supabase = sb;