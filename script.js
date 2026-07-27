function renderQR(elId, text) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  new QRCode(el, {
    text: text,
    width: 120,
    height: 120,
    colorDark: '#202124',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
}

function renderFakeUPI(elId) {
  const el = document.getElementById(elId);
  el.innerHTML = '';
  new QRCode(el, {
    text: 'upi://pay?pa=example@upi&pn=Demo&am=450&cu=INR',
    width: 120,
    height: 120,
    colorDark: '#5F259F',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
}

function updateAll() {
  const name = document.getElementById('bizName').value || 'Your Business';
  const link = document.getElementById('reviewLink').value || 'https://g.page/r/example/review';
  document.getElementById('upi-biz-name').textContent = name;
  document.getElementById('phone-biz-name').textContent = name;
  document.getElementById('phone-amount').textContent = '₹450 paid to ' + name;
  document.getElementById('card-biz-name').textContent = name;

  renderFakeUPI('qr-fake-upi');
  renderQR('qr-review-counter', link);
  renderQR('qr-review-phone', link);
  renderQR('qr-review-card', link);
}

document.getElementById('bizName').addEventListener('input', updateAll);
document.getElementById('reviewLink').addEventListener('input', updateAll);

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.scene').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('scene-' + btn.dataset.tab).classList.add('active');
  });
});

updateAll();
