const app = document.getElementById("app");

function render() {
  const hash = location.hash || "#/wishlist";
  if (hash.startsWith("#/wishlist")) app.innerHTML = "<h1>Wishlist</h1><p>Shell is live ✅</p>";
  else if (hash.startsWith("#/new")) app.innerHTML = "<h1>New Tasting</h1><p>Shell is live ✅</p>";
  else if (hash.startsWith("#/tried")) app.innerHTML = "<h1>Tried</h1><p>Shell is live ✅</p>";
  else app.innerHTML = "<h1>Not found</h1>";
}

window.addEventListener("hashchange", render);
render();
