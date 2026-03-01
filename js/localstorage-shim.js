// ── localStorage shim ──────────────────────────────────────────────────────
// Supabase realtime tries to use localStorage even when auth uses memStorage.
// In Edge/Safari with Tracking Prevention this throws. We patch it silently.
(function () {
  var _store = {};
  var _safe = {
    getItem:    function(k) { try { return window.localStorage.getItem(k); } catch(e) { return _store[k]||null; } },
    setItem:    function(k,v){ try { window.localStorage.setItem(k,v);    } catch(e) { _store[k]=v; }          },
    removeItem: function(k)  { try { window.localStorage.removeItem(k);   } catch(e) { delete _store[k]; }      },
    key:        function(i)  { try { return window.localStorage.key(i);   } catch(e) { return null; }           },
    get length(){ try { return window.localStorage.length;                } catch(e) { return Object.keys(_store).length; } },
    clear:      function()   { try { window.localStorage.clear();          } catch(e) { _store={}; }             },
  };
  try { window.localStorage.getItem('__test__'); }
  catch (e) { Object.defineProperty(window,'localStorage',{get:function(){return _safe;},configurable:true}); }
})();