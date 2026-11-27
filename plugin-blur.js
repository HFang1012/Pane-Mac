// Focus mode's blur. "cover" fills a screen the app isn't on and names the app you're focused on there;
// "around" is one of the four pieces laid around the focused window, plain.
const q = new URLSearchParams(location.search);
document.body.classList.toggle('desk', q.get('kind') !== 'cover');
if (q.get('kind') === 'cover') {
  document.getElementById('t').textContent = `Focusing on ${q.get('name') || 'one app'}`;
  document.getElementById('chip').hidden = false;
}
