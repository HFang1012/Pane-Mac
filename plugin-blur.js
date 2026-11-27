// Focus mode's blur: names the app you're focused on, on the screens it isn't on.
const q = new URLSearchParams(location.search);
document.body.classList.toggle('desk', q.get('kind') === 'desk');
if (q.get('kind') === 'cover') {
  document.getElementById('t').textContent = `Focusing on ${q.get('name') || 'one app'}`;
  document.getElementById('chip').hidden = false;
}
