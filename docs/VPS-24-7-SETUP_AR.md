# تشغيل Oracle المدمج على VPS على مدار الساعة

## الخلاصة التنفيذية

للمشروع الحالي، أفضل إعداد هو **Ubuntu VPS + systemd timers + حساب Linux مستقل باسم `oracle`**. لا يحتاج العامل إلى إبقاء المتصفح مفتوحاً؛ يستدعي عامل Node كل ثلاث ساعات، ويشغّل التقارير اليومية والأسبوعية والشهرية في أوقات UTC محددة، ويعيد تشغيل الجدولة تلقائياً بعد إعادة تشغيل الخادم.

هذا يختلف عن إبقاء عملية واحدة تعمل بلا توقف: بما أن المطلوب إشارة كل ثلاث ساعات، فإن المؤقتات المجدولة أكثر كفاءة وأسهل في المراقبة. إذا كان المقصود مراقبة لحظية كل ثانية أو كل دقيقة، فحينها يُضاف عامل مستمر منفصل، لكن ذلك غير مطلوب لدورية الإشارات الحالية.

> **تنبيه تشغيلي:** النظام يولد إشارات بحثية شخصية ولا ينفذ أوامر تداول لدى وسيط. لا تعتبر نسبة النجاح المرصودة أو التقدير اللاحق ضماناً للنتيجة المستقبلية.

## مقارنة الخيارات

| النهج | المفاضلات | التكلفة | تعقيد الإعداد |
|---|---|---:|---|
| VPS Ubuntu مع systemd، وهو النهج الموصى به للمشروع | تحكم كامل، تشغيل مستقل عن GitHub Actions، يحتاج تحديثات وتأمين ونسخاً احتياطية | رسوم VPS لدى مزودك | متوسط |
| Docker Compose على VPS | قابلية نقل أعلى وعزل جيد، لكنه يضيف طبقة Docker وإدارة صور وسجلات | رسوم VPS نفسها تقريباً | متوسط إلى مرتفع |
| الاستمرار على GitHub Actions | أبسط إعداد، لكن الجدولة قد تتأخر، وقد يحدث تكرار أو تعارض مع بيانات VPS، وليس عاملاً دائماً | غالباً بلا VPS إضافي | منخفض |

## مواصفات الخادم المقترحة

ابدأ بخادم Ubuntu Server 22.04 أو 24.04، ويفضل **1 vCPU و1 GB RAM على الأقل**، مع 20 GB تخزين وذاكرة swap صغيرة. إذا كانت مصادر الأخبار أو عدد الأزواج سيزداد، فاختيار 2 GB RAM أكثر راحة. لا يحتاج هذا العامل إلى منفذ HTTP عام؛ يحتاج إلى اتصال HTTPS صادر إلى Twelve Data وNewsAPI وTelegram، وإلى SSH للإدارة.

## قرار مهم قبل التنصيب

المستودع الحالي يحتوي على Workflow من GitHub Actions يكتب إلى `data/` ويرسل Telegram. عند نقل التشغيل إلى VPS، يجب **تعطيل Workflow الحالي** بعد نجاح الاختبار، وإلا قد تحصل على إشارتين لنفس النافذة، أو تقريرين، أو تعارض بين بيانات VPS وcommits GitHub. سيبقى GitHub مستودع الكود والنسخ المصدرية، بينما يصبح VPS مصدر التشغيل والبيانات.

## المرحلة الأولى: تحديث Ubuntu وتأمين الدخول

نفّذ الأوامر التالية من جلسة SSH. لا تغلق جلسة SSH الحالية قبل اختبار جلسة ثانية حتى لا تفقد الوصول إلى الخادم.

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y git curl ca-certificates ufw fail2ban unattended-upgrades

# إنشاء حساب تشغيل غير root
sudo adduser --system --group --home /home/oracle oracle
sudo install -d -o oracle -g oracle /opt/oracle-merged
sudo install -d -o root -g oracle -m 0750 /etc/oracle-merged
sudo install -d -o oracle -g oracle /var/lib/oracle-merged
```

ثبّت Node.js من مستودع التوزيعة أولاً، ثم تحقق من الإصدار. العامل يستخدم `fetch` المدمج في Node، لذلك يلزم Node 18 أو أحدث.

```bash
sudo apt install -y nodejs
node --version
node -e "if (Number(process.versions.node.split('.')[0]) < 18) { console.error('Node 18+ required'); process.exit(1) }"
```

إذا كان إصدار مستودع Ubuntu أقدم من 18، ثبّت إصدار Node LTS حديثاً من مصدر Node الرسمي أو من مدير حزم موثوق، ثم أعد فحص الإصدار. لا تشغّل العامل من حساب root.

فعّل الجدار الناري بعد السماح بـ SSH. إذا كان مزود VPS يستخدم منفذاً غير 22، استبدل الرقم بالمنفذ الفعلي. يمكن تقييد SSH بعنوان IP ثابت خاص بك بدلاً من فتحه للعالم.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status verbose
sudo systemctl enable --now fail2ban
```

توثّق Ubuntu أن `ufw` هو الواجهة الافتراضية المبسطة لإدارة جدار Ubuntu، وأن فتح SSH يجب أن يسبق تفعيل الجدار الناري حتى لا تُغلق جلسة الإدارة [2].

## المرحلة الثانية: ربط VPS بالمستودع

بعد جعل المستودع خاصاً، أنشئ مفتاح نشر **للقراءة فقط** على الخادم. المفتاح العام يُضاف إلى إعدادات المستودع، أما الخاص فيبقى في VPS ولا يُرفع إلى GitHub.

```bash
sudo -u oracle mkdir -p /home/oracle/.ssh
sudo -u oracle chmod 700 /home/oracle/.ssh
sudo -u oracle ssh-keygen -t ed25519 \
  -f /home/oracle/.ssh/github_owner_repository \
  -C "oracle-vps-readonly" -N ""

sudo cat /home/oracle/.ssh/github_owner_repository.pub
```

انسخ المفتاح العام إلى GitHub من: **Repository → Settings → Deploy keys → Add deploy key**، ولا تفعّل **Allow write access**. توضح وثائق GitHub أن Deploy Key يمكن ربطه بمستودع واحد، وأنه للقراءة فقط افتراضياً؛ كما توصي باستخدام GitHub App عندما تحتاج صلاحيات أكثر دقة [3].

أنشئ إعداد SSH للمستخدم `oracle`:

```bash
sudo tee /home/oracle/.ssh/config >/dev/null <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile /home/oracle/.ssh/github_owner_repository
  IdentitiesOnly yes
EOF
sudo chown oracle:oracle /home/oracle/.ssh/config
sudo chmod 600 /home/oracle/.ssh/config
```

تحقق من بصمة GitHub المنشورة رسمياً قبل إضافة host key، ثم نفّذ:

```bash
sudo -u oracle ssh-keyscan -t ed25519 github.com >> /home/oracle/.ssh/known_hosts
sudo chmod 644 /home/oracle/.ssh/known_hosts
sudo -u oracle ssh -T git@github.com || true
sudo -u oracle git clone git@github.com:lo77667/owner-repository.git /opt/oracle-merged
sudo chown -R oracle:oracle /opt/oracle-merged
```

تُعرّف وثائق GitHub Deploy Key بأنه مفتاح يتيح للخادم تشغيل مشروع من مستودع محدد، وتشرح مسار الإضافة من إعدادات المستودع [3].

## المرحلة الثالثة: فصل بيانات التشغيل عن الكود

الكود الحالي يعرّف مسار البيانات من مجلد العمل. لتجنب تعارض `git pull` مع `data/signals.json` والتقارير الناتجة، عدّل تعريف المسار في `worker/signal-worker.mjs` مرة واحدة:

```js
const DATA_DIR = process.env.SIGNAL_DATA_DIR || path.join(ROOT, 'data');
```

ثم ارفع هذا التعديل إلى GitHub. بعد ذلك أنشئ مجلد البيانات خارج المستودع:

```bash
sudo install -d -o oracle -g oracle -m 0750 /var/lib/oracle-merged/data
sudo cp -n /opt/oracle-merged/data/signals.json /var/lib/oracle-merged/data/signals.json || true
sudo chown -R oracle:oracle /var/lib/oracle-merged/data
```

بهذا يصبح GitHub مصدراً للكود، بينما تبقى سجلات الإشارات والتقارير خارج شجرة Git ولا تُفقد عند تحديث الكود.

## المرحلة الرابعة: حفظ الأسرار خارج GitHub

أنشئ ملف الأسرار على VPS فقط. لا تضعه في المستودع ولا ترسله داخل Telegram أو المحادثات.

```bash
sudo tee /etc/oracle-merged/oracle.env >/dev/null <<'EOF'
SIGNAL_DATA_DIR=/var/lib/oracle-merged/data
SIGNAL_PAIRS=EUR/USD,GBP/USD,USD/JPY,USD/CHF,AUD/USD,USD/CAD,NZD/USD,EUR/GBP,EUR/JPY,GBP/JPY,AUD/JPY,EUR/AUD
MIN_CONFIDENCE=55
RISK_REWARD=2
MAX_HOLD_HOURS=24
SIGNAL_SLOT_HOURS=3
TWELVE_DATA_KEY=ضع_المفتاح_هنا
NEWS_API_KEY=ضع_المفتاح_هنا
TELEGRAM_BOT_TOKEN=ضع_الرمز_هنا
TELEGRAM_CHAT_ID=ضع_المعرف_هنا
EOF
sudo chown root:oracle /etc/oracle-merged/oracle.env
sudo chmod 640 /etc/oracle-merged/oracle.env
sudo -u oracle test -r /etc/oracle-merged/oracle.env
```

إذا كان رمز Telegram قد ظهر سابقاً داخل الملفات، أبطله وأنشئ رمزاً جديداً قبل وضعه هنا. في تشغيل `signal` يتطلب العامل مفتاح Twelve Data ورمز Telegram ومعرّف المحادثة؛ مفتاح الأخبار اختياري، وعند غيابه تعمل الإشارة دون انحياز أخبار.

## المرحلة الخامسة: خدمة systemd للإشارة

يعمل systemd كمدير ومشرف للخدمات، وملف `.service` يصف العملية التي يتولى تشغيلها ومراقبتها [1]. أنشئ خدمة قصيرة التنفيذ تُستدعى بواسطة مؤقت كل ثلاث ساعات:

```bash
sudo tee /etc/systemd/system/oracle-signal.service >/dev/null <<'EOF'
[Unit]
Description=Oracle merged signal generation
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
User=oracle
Group=oracle
WorkingDirectory=/opt/oracle-merged
EnvironmentFile=/etc/oracle-merged/oracle.env
ExecStart=/usr/bin/node /opt/oracle-merged/worker/signal-worker.mjs --mode=signal
TimeoutStartSec=15min
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/oracle-merged/data

[Install]
WantedBy=multi-user.target
EOF
```

تحقق من مكان Node إذا كان مختلفاً:

```bash
command -v node
```

إذا أعاد مساراً غير `/usr/bin/node` فعدّل `ExecStart` إلى المسار الصحيح.

أنشئ مؤقت الإشارات المتوافق مع نوافذ UTC الثلاثية:

```bash
sudo tee /etc/systemd/system/oracle-signal.timer >/dev/null <<'EOF'
[Unit]
Description=Run Oracle signal generation every three hours UTC

[Timer]
OnCalendar=*-*-* 00,03,06,09,12,15,18,21:00:00 UTC
Persistent=true
RandomizedDelaySec=30
Unit=oracle-signal.service

[Install]
WantedBy=timers.target
EOF
```

## المرحلة السادسة: خدمات التقارير

أنشئ خدمة تقرير عامة تستقبل الوضع من اسم الوحدة، ثم ثلاثة مؤقتات منفصلة:

```bash
sudo tee /etc/systemd/system/oracle-report@.service >/dev/null <<'EOF'
[Unit]
Description=Oracle merged %i report
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=oracle
Group=oracle
WorkingDirectory=/opt/oracle-merged
EnvironmentFile=/etc/oracle-merged/oracle.env
ExecStart=/usr/bin/node /opt/oracle-merged/worker/signal-worker.mjs --mode=%i
TimeoutStartSec=10min
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/oracle-merged/data
EOF

sudo tee /etc/systemd/system/oracle-report-daily.timer >/dev/null <<'EOF'
[Unit]
Description=Oracle daily report
[Timer]
OnCalendar=*-*-* 00:05:00 UTC
Persistent=true
Unit=oracle-report@daily.service
[Install]
WantedBy=timers.target
EOF

sudo tee /etc/systemd/system/oracle-report-weekly.timer >/dev/null <<'EOF'
[Unit]
Description=Oracle weekly report
[Timer]
OnCalendar=Sun *-*-* 00:10:00 UTC
Persistent=true
Unit=oracle-report@weekly.service
[Install]
WantedBy=timers.target
EOF

sudo tee /etc/systemd/system/oracle-report-monthly.timer >/dev/null <<'EOF'
[Unit]
Description=Oracle monthly report
[Timer]
OnCalendar=*-*-01 00:15:00 UTC
Persistent=true
Unit=oracle-report@monthly.service
[Install]
WantedBy=timers.target
EOF
```

## المرحلة السابعة: التفعيل والاختبار

أعد تحميل وحدات systemd، ثم شغّل اختبار التقرير أولاً. هذا الاختبار لا يحتاج بيانات سوق مباشرة، بينما اختبار الإشارة يحتاج الأسرار واتصالاً خارجياً.

```bash
sudo systemctl daemon-reload
sudo systemctl start oracle-report@daily.service
sudo systemctl status oracle-report@daily.service --no-pager
sudo journalctl -u oracle-report@daily.service -n 80 --no-pager
```

بعد التحقق من الأسرار، اختبر إشارة واحدة يدوياً:

```bash
sudo systemctl start oracle-signal.service
sudo systemctl status oracle-signal.service --no-pager
sudo journalctl -u oracle-signal.service -n 120 --no-pager
sudo -u oracle jq . /var/lib/oracle-merged/data/signals.json 2>/dev/null || \
  sudo -u oracle cat /var/lib/oracle-merged/data/signals.json
```

إذا وصلت رسالة Telegram وسُجلت نافذة UTC الحالية، فعّل المؤقتات:

```bash
sudo systemctl enable --now oracle-signal.timer
sudo systemctl enable --now oracle-report-daily.timer
sudo systemctl enable --now oracle-report-weekly.timer
sudo systemctl enable --now oracle-report-monthly.timer
sudo systemctl list-timers --all | grep oracle
```

تأكد من عدم وجود أكثر من مسار تشغيل:

```bash
sudo systemctl disable --now oracle-signal.service 2>/dev/null || true
# لا تعطل المؤقت؛ السطر السابق يوقف الخدمة اليدوية فقط.
sudo systemctl list-timers --all | grep oracle
```

## المرحلة الثامنة: تعطيل GitHub Actions بعد نجاح VPS

بعد نجاح الاختبار، عطّل Workflow `Oracle merged signal schedule` من تبويب **Actions** في GitHub أو احذف/أعد تسمية ملف `.github/workflows/oracle-schedule.yml` في فرع التشغيل. لا تترك GitHub Actions وVPS يرسلان الإشارات في الوقت نفسه.

للتحديثات المستقبلية للكود، نفّذ بعد أخذ نسخة احتياطية من البيانات:

```bash
sudo tar -czf /var/backups/oracle-merged-$(date -u +%Y%m%d-%H%M%S).tgz \
  -C /var/lib/oracle-merged data
sudo -u oracle git -C /opt/oracle-merged fetch origin
sudo -u oracle git -C /opt/oracle-merged pull --ff-only origin main
sudo systemctl daemon-reload
sudo systemctl restart oracle-signal.timer
```

إذا لم تطبق فصل البيانات في المرحلة الثالثة، لا تنفذ `git pull` قبل حفظ واستعادة `data/`، لأن العامل يكتب داخل مجلد Git. فصل `SIGNAL_DATA_DIR` هو المسار الآمن الموصى به.

## النسخ الاحتياطي والمراقبة

أنشئ نسخة يومية من `/var/lib/oracle-merged/data` إلى قرص أو مخزن مختلف عن نفس VPS. الاحتفاظ بالنسخة على نفس القرص لا يحمي من تلف القرص أو حذف الخادم. يمكن استخدام `restic` أو `rclone` أو تخزين S3 متوافق، على أن يكون مفتاح التخزين منفصلاً عن مفاتيح السوق وTelegram.

راقب هذه الأوامر دورياً:

```bash
systemctl list-timers --all | grep oracle
journalctl -u oracle-signal.service --since '24 hours ago' --no-pager
journalctl -u 'oracle-report@*.service' --since '7 days ago' --no-pager
stat /var/lib/oracle-merged/data/signals.json
```

أنشئ تنبيهاً خارجياً إذا لم يتغير `signals.json` بعد نافذة متوقعة، أو إذا فشل آخر تشغيل، أو إذا انخفضت مساحة القرص. لا تعتمد على نسبة النجاح وحدها؛ راقب أيضاً عدد الإشارات المغلقة، أسباب الإغلاق، الانزلاق، جودة البيانات، وفترة الاحتفاظ.

## تعريف الجاهزية

يُعد VPS جاهزاً للتشغيل الشخصي عندما تتحقق الشروط التالية: لا توجد أسرار داخل Git، المستودع الخاص هو مصدر الكود، GitHub Actions الخاص بالإشارات معطل، خدمة الإشارة تعمل بحساب `oracle` غير root، المؤقتات الأربعة تظهر في `systemctl list-timers`, تصل رسالة اختبار واحدة إلى Telegram، تسجل البيانات خارج مجلد Git، وتوجد نسخة احتياطية قابلة للاستعادة.

## المراجع

[1]: https://www.freedesktop.org/software/systemd/man/systemd.service.html "systemd.service — Service unit configuration"

[2]: https://ubuntu.com/server/docs/how-to/security/firewalls/ "Ubuntu Server documentation — Firewall"

[3]: https://docs.github.com/v3/guides/managing-deploy-keys "GitHub Docs — Managing deploy keys"
