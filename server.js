require('dotenv').config();

const express = require('express');
const initSqlJs = require('sql.js');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');

async function boot(){
const app = express();

const SQL = await initSqlJs({
 locateFile: file => require.resolve('sql.js/dist/' + file)
});

const isTermux = Boolean(process.env.PREFIX && process.env.PREFIX.includes('/com.termux/'));
const dataDir = process.env.DATA_DIR || (isTermux ? __dirname : (process.env.PORT ? '/data' : __dirname));
fs.mkdirSync(dataDir, { recursive: true });

const dbFile = path.join(dataDir, 'mozwork.db');
const legacyDbFile = path.join(__dirname, 'mozwork.db');

// Migração automática da base antiga, sem apagar o ficheiro original.
if (
 !fs.existsSync(dbFile) &&
 legacyDbFile !== dbFile &&
 fs.existsSync(legacyDbFile)
) {
 fs.copyFileSync(legacyDbFile, dbFile);
 console.log('Base de dados antiga copiada para:', dbFile);
}

const rawDb = fs.existsSync(dbFile)
 ? new SQL.Database(new Uint8Array(fs.readFileSync(dbFile)))
 : new SQL.Database();

rawDb.run('PRAGMA foreign_keys = ON');

let transactionDepth = 0;

function persist(){
 fs.writeFileSync(dbFile, Buffer.from(rawDb.export()));
}

const db = {
 exec(sql){
  rawDb.exec(sql);
  if(!transactionDepth) persist();
 },

 pragma(sql){
  rawDb.run('PRAGMA ' + sql);
 },

 prepare(sql){
  return {
   get(...params){
    const stmt = rawDb.prepare(sql);
    try{
     if(params.length) stmt.bind(params);
     if(!stmt.step()) return undefined;
     return stmt.getAsObject();
    }finally{
     stmt.free();
    }
   },

   all(...params){
    const stmt = rawDb.prepare(sql);
    const rows = [];
    try{
     if(params.length) stmt.bind(params);
     while(stmt.step()) rows.push(stmt.getAsObject());
     return rows;
    }finally{
     stmt.free();
    }
   },

   run(...params){
    const stmt = rawDb.prepare(sql);
    try{
     if(params.length) stmt.bind(params);
     stmt.step();
    }finally{
     stmt.free();
    }

    const changes = rawDb.getRowsModified();
    const result = rawDb.exec(
     'SELECT last_insert_rowid() AS id'
    );
    const lastInsertRowid =
     result.length ? result[0].values[0][0] : 0;

    if(!transactionDepth) persist();

    return {changes,lastInsertRowid};
   }
  };
 },

 transaction(fn){
  return function(){
   rawDb.run('BEGIN TRANSACTION');
   transactionDepth++;

   try{
    const result = fn();
    rawDb.run('COMMIT');
    transactionDepth--;
    persist();
    return result;
   }catch(error){
    rawDb.run('ROLLBACK');
    transactionDepth--;
    throw error;
   }
  };
 }
};



app.set('trust proxy', 1);

app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,'public')));

const proofDir = path.join(__dirname,'public','uploads','proofs');
fs.mkdirSync(proofDir,{recursive:true});

const adDir = path.join(__dirname,'public','uploads','ads');
fs.mkdirSync(adDir,{recursive:true});

const adStorage = multer.diskStorage({
 destination:(req,file,cb)=>cb(null,adDir),
 filename:(req,file,cb)=>{
  const ext=path.extname(file.originalname).toLowerCase();
  cb(null,'ad-'+Date.now()+'-'+Math.random().toString(36).slice(2)+ext);
 }
});

const adUpload = multer({
 storage:adStorage,
 limits:{fileSize:5*1024*1024},
 fileFilter:(req,file,cb)=>{
  const allowed=['image/jpeg','image/png','image/webp','image/gif'];
  if(!allowed.includes(file.mimetype))
   return cb(new Error('Imagem inválida. Use JPG, PNG, WEBP ou GIF.'));
  cb(null,true);
 }
});


const proofStorage = multer.diskStorage({
 destination:(req,file,cb)=>cb(null,proofDir),
 filename:(req,file,cb)=>{
  const ext=path.extname(file.originalname).toLowerCase();
  cb(null,Date.now()+'-'+Math.random().toString(36).slice(2)+ext);
 }
});

const upload = multer({
 storage:proofStorage,
 limits:{fileSize:5*1024*1024},
 fileFilter:(req,file,cb)=>{
  const allowed=['image/jpeg','image/png','image/webp','image/gif'];
  if(!allowed.includes(file.mimetype))
   return cb(new Error('Formato inválido. Envie JPG, PNG, WEBP ou GIF.'));
  cb(null,true);
 }
});
app.use(rateLimit({windowMs:900000,limit:300}));

/* BANCO DE DADOS SQLITE */

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 phone TEXT UNIQUE NOT NULL,
 passwordHash TEXT NOT NULL,
 role TEXT DEFAULT 'user',
 balance REAL DEFAULT 0,
 blocked INTEGER DEFAULT 0,
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 description TEXT,
 reward REAL NOT NULL,
 slots INTEGER DEFAULT 0,
 publishedAt TEXT DEFAULT CURRENT_TIMESTAMP,
 expiresAt TEXT,
 active INTEGER DEFAULT 1,
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS submissions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user INTEGER NOT NULL,
 task INTEGER NOT NULL,
 proof TEXT NOT NULL,
 reward REAL NOT NULL,
 status TEXT DEFAULT 'pending',
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user) REFERENCES users(id),
 FOREIGN KEY(task) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user INTEGER NOT NULL,
 amount REAL NOT NULL,
 fee REAL NOT NULL,
 net REAL NOT NULL,
 method TEXT NOT NULL,
 phone TEXT NOT NULL,
 status TEXT DEFAULT 'pending',
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user INTEGER NOT NULL,
 sender TEXT NOT NULL,
 text TEXT NOT NULL,
 read INTEGER DEFAULT 0,
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user) REFERENCES users(id)
);


CREATE TABLE IF NOT EXISTS bots (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 reward REAL NOT NULL,
 slots INTEGER DEFAULT 0,
 intervalMinutes INTEGER NOT NULL,
 remaining INTEGER NOT NULL,
 nextRun TEXT NOT NULL,
 active INTEGER DEFAULT 1,
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);


CREATE TABLE IF NOT EXISTS ads (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL,
 description TEXT,
 imageUrl TEXT,
 targetUrl TEXT NOT NULL,
 startAt TEXT NOT NULL,
 endAt TEXT NOT NULL,
 active INTEGER DEFAULT 1,
 impressions INTEGER DEFAULT 0,
 clicks INTEGER DEFAULT 0,
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 company TEXT NOT NULL,
 phone TEXT NOT NULL,
 title TEXT NOT NULL,
 description TEXT,
 imageUrl TEXT,
 targetUrl TEXT NOT NULL,
 status TEXT DEFAULT 'pending',
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_submissions_user
 ON submissions(user);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user
 ON withdrawals(user);

CREATE INDEX IF NOT EXISTS idx_messages_user
 ON messages(user);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS task_acceptances (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user INTEGER NOT NULL,
 task INTEGER NOT NULL,
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user,task),
 FOREIGN KEY(user) REFERENCES users(id),
 FOREIGN KEY(task) REFERENCES tasks(id)
);
`);


/* NOTIFICAÇÕES MOZWORK */
db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user INTEGER NOT NULL,
 title TEXT NOT NULL,
 text TEXT NOT NULL,
 type TEXT DEFAULT 'info',
 read INTEGER DEFAULT 0,
 createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user
 ON notifications(user);
`);

const submissionColumns=db.prepare('PRAGMA table_info(submissions)').all();
const existingColumns=submissionColumns.map(c=>c.name);

if(!existingColumns.includes('proofType'))
 db.exec("ALTER TABLE submissions ADD COLUMN proofType TEXT DEFAULT 'link'");

if(!existingColumns.includes('photoPath'))
 db.exec("ALTER TABLE submissions ADD COLUMN photoPath TEXT");

if(!existingColumns.includes('description'))
 db.exec("ALTER TABLE submissions ADD COLUMN description TEXT");

const mt = n => Math.round((Number(n)+Number.EPSILON)*100)/100;

const safe = u => ({
 id:u.id,
 name:u.name,
 phone:u.phone,
 role:u.role,
 balance:u.balance,
 blocked:Boolean(u.blocked)
});

const wrap = fn => (req,res,next) =>
 Promise.resolve(fn(req,res,next)).catch(next);

/* FUNÇÕES DE NOTIFICAÇÃO */
function notifyUser(userId,title,text,type='info'){
 db.prepare(`
  INSERT INTO notifications(user,title,text,type)
  VALUES(?,?,?,?)
 `).run(Number(userId),String(title),String(text),String(type));
}

function notifyAll(title,text,type='info'){
 const users=db.prepare(`
  SELECT id FROM users WHERE role='user' AND blocked=0
 `).all();

 for(const u of users){
  notifyUser(u.id,title,text,type);
 }

 return users.length;
}
/* SESSÕES */

app.use(session({
 secret:process.env.SESSION_SECRET || 'mozwork-session-change-this-secret',
 resave:false,
 saveUninitialized:false,
 cookie:{
  httpOnly:true,
  sameSite:'lax',
  secure:process.env.NODE_ENV==='production',
  maxAge:604800000
 }
}));

/* AUTENTICAÇÃO */

function auth(req,res,next){
 if(!req.session.uid)
  return res.status(401).json({error:'Faça login.'});

 const u=db.prepare('SELECT * FROM users WHERE id=?')
  .get(req.session.uid);

 if(!u || u.blocked){
  req.session.destroy(()=>{});
  return res.status(401).json({error:'Conta indisponível.'});
 }

 req.user=u;
 next();
}

function admin(req,res,next){
 if(req.user.role!=='admin')
  return res.status(403).json({
   error:'Acesso reservado ao administrador.'
  });

 next();
}

/* CONTAS */

app.post('/api/register',wrap(async(req,res)=>{
 const name=String(req.body.name||'').trim();
 const phone=String(req.body.phone||'').replace(/\s/g,'');
 const pin=String(req.body.pin||'');

 if(name.length<2 ||
 !/^[0-9]{9,15}$/.test(phone) ||
 !/^[0-9]{4,20}$/.test(pin)){
  return res.status(400).json({
   error:'Dados inválidos. PIN mínimo de 4 dígitos.'
  });
 }

 const exists=db.prepare(
  'SELECT id FROM users WHERE phone=?'
 ).get(phone);

 if(exists)
  return res.status(409).json({
   error:'Telefone já registado.'
  });

 const hash=await bcrypt.hash(pin,12);

 const result=db.prepare(`
  INSERT INTO users(name,phone,passwordHash)
  VALUES(?,?,?)
 `).run(name,phone,hash);

 req.session.uid=Number(result.lastInsertRowid);

 const u=db.prepare(
  'SELECT * FROM users WHERE id=?'
 ).get(req.session.uid);

 res.json({user:safe(u)});
}));

app.post('/api/admin/login',wrap(async(req,res)=>{
 const username=String(req.body.username||'').trim();
 const expected=String(process.env.ADMIN_USERNAME||'');

 if(!expected || username!==expected)
  return res.status(401).json({error:'Usuário incorrecto.'});

 const u=db.prepare(
  "SELECT * FROM users WHERE role='admin' LIMIT 1"
 ).get();

 if(!u)
  return res.status(403).json({error:'Administrador não encontrado.'});

 if(u.blocked)
  return res.status(403).json({error:'Conta administrativa indisponível.'});

 req.session.uid=u.id;
 res.json({user:safe(u)});
}));

app.post('/api/login',wrap(async(req,res)=>{
 const phone=String(req.body.phone||'').replace(/\s/g,'');
 const pin=String(req.body.pin||'');

 const u=db.prepare(
  'SELECT * FROM users WHERE phone=?'
 ).get(phone);

 if(!u || !(await bcrypt.compare(pin,u.passwordHash)))
  return res.status(401).json({
   error:'Telefone ou PIN incorrecto.'
  });

 if(u.blocked)
  return res.status(403).json({
   error:'Conta bloqueada.'
  });

 req.session.uid=u.id;

 res.json({user:safe(u)});
}));

app.post('/api/logout',(req,res)=>{
 req.session.destroy(()=>res.json({ok:true}));
});

app.get('/api/me',auth,(req,res)=>{
 res.json({user:safe(req.user)});
});


/* NOTIFICAÇÕES */

app.get('/api/notifications',auth,wrap(async(req,res)=>{
 if(req.user.role!=='user')
  return res.status(403).json({error:'Acesso reservado aos trabalhadores.'});

 const items=db.prepare(`
  SELECT id,title,text,type,read,createdAt
  FROM notifications WHERE user=?
  ORDER BY id DESC LIMIT 50
 `).all(req.user.id);

 const unread=db.prepare(`
  SELECT COUNT(*) AS total
  FROM notifications WHERE user=? AND read=0
 `).get(req.user.id);

 res.json({items,unreadCount:unread.total});
}));

app.patch('/api/notifications/:id/read',auth,wrap(async(req,res)=>{
 if(req.user.role!=='user')
  return res.status(403).json({error:'Acesso reservado aos trabalhadores.'});

 db.prepare(`
  UPDATE notifications SET read=1 WHERE id=? AND user=?
 `).run(req.params.id,req.user.id);

 res.json({ok:true});
}));

app.patch('/api/notifications/read-all',auth,wrap(async(req,res)=>{
 if(req.user.role!=='user')
  return res.status(403).json({error:'Acesso reservado aos trabalhadores.'});

 db.prepare(`
  UPDATE notifications SET read=1 WHERE user=?
 `).run(req.user.id);

 res.json({ok:true});
}));

app.post('/api/admin/notifications',auth,admin,wrap(async(req,res)=>{
 const title=String(req.body.title||'').trim();
 const text=String(req.body.text||'').trim();
 const userId=Number(req.body.userId||0);

 if(title.length<3 || title.length>100 || !text || text.length>2000)
  return res.status(400).json({error:'Título ou mensagem inválidos.'});

 if(req.body.all===true){
  const total=notifyAll(title,text,'announcement');
  return res.json({ok:true,total});
 }

 const user=db.prepare(`
  SELECT id FROM users WHERE id=? AND role='user'
 `).get(userId);

 if(!user)
  return res.status(404).json({error:'Trabalhador não encontrado.'});

 notifyUser(user.id,title,text,'announcement');
 res.json({ok:true,total:1});
}));

/* TAREFAS */

app.get('/api/tasks',auth,wrap(async(req,res)=>{
 const now=new Date().toISOString();

 const tasks=db.prepare(`
  SELECT * FROM tasks
  WHERE active=1
  AND publishedAt<=?
  AND (expiresAt IS NULL OR expiresAt>?)
  AND NOT EXISTS(
   SELECT 1 FROM task_acceptances a
   WHERE a.task=tasks.id AND a.user=?
  )
  AND NOT EXISTS(
   SELECT 1 FROM submissions s
   WHERE s.task=tasks.id AND s.user=?
  )
  ORDER BY createdAt DESC
 `).all(now,now,req.user.id,req.user.id);

 res.json({tasks});
}));

app.post('/api/tasks/:id/accept',auth,wrap(async(req,res)=>{
 const now=new Date().toISOString();

 const task=db.prepare(`
  SELECT * FROM tasks
  WHERE id=? AND active=1
  AND publishedAt<=?
  AND (expiresAt IS NULL OR expiresAt>?)
 `).get(req.params.id,now,now);

 if(!task)
  return res.status(404).json({error:'Tarefa indisponível.'});

 const exists=db.prepare(`
  SELECT id FROM task_acceptances WHERE user=? AND task=?
 `).get(req.user.id,task.id);

 const submitted=db.prepare(`
  SELECT id FROM submissions WHERE user=? AND task=?
 `).get(req.user.id,task.id);

 if(exists || submitted)
  return res.status(409).json({error:'Já aceitou ou enviou esta tarefa.'});

 if(Number(task.slots)>0){
  const count=db.prepare(`
   SELECT COUNT(*) AS total FROM task_acceptances WHERE task=?
  `).get(task.id);

  if(Number(count.total)>=Number(task.slots))
   return res.status(409).json({error:'As vagas desta tarefa já foram preenchidas.'});
 }

 db.prepare(`
  INSERT INTO task_acceptances(user,task) VALUES(?,?)
 `).run(req.user.id,task.id);

 res.json({ok:true,message:'Tarefa aceite! Encontra-a em Minhas tarefas.'});
}));

app.post('/api/tasks/:id/submit',auth,upload.single('photo'),wrap(async(req,res)=>{
 const now=new Date().toISOString();

 const task=db.prepare(`
  SELECT * FROM tasks
  WHERE id=? AND active=1
  AND publishedAt<=?
  AND (expiresAt IS NULL OR expiresAt>?)
 `).get(req.params.id,now,now);

 if(!task){
  if(req.file) fs.unlinkSync(req.file.path);
  return res.status(404).json({error:'Tarefa indisponível.'});
 }

 const accepted=db.prepare(`
  SELECT id FROM task_acceptances WHERE user=? AND task=?
 `).get(req.user.id,task.id);

 if(!accepted){
  if(req.file) fs.unlinkSync(req.file.path);
  return res.status(403).json({error:'Primeiro deve aceitar esta tarefa.'});
 }

 const proofType=String(req.body.proofType||'');
 const proof=String(req.body.proof||'').trim();
 const description=String(req.body.description||'').trim();

 let photoPath=null;
 let savedProof='';

 if(proofType==='photo'){
  if(!req.file)
   return res.status(400).json({error:'Envie a fotografia da prova.'});
  photoPath='/uploads/proofs/'+req.file.filename;
  savedProof='Fotografia enviada';
 }
 else if(proofType==='link'){
  try{
   const u=new URL(proof);
   if(!['http:','https:'].includes(u.protocol)) throw Error();
  }catch(e){
   return res.status(400).json({error:'Introduza um link válido começado por https:// ou http://'});
  }
  savedProof=proof;
 }
 else if(proofType==='photo_description'){
  if(!req.file || description.length<3){
   if(req.file) fs.unlinkSync(req.file.path);
   return res.status(400).json({error:'Envie uma fotografia e escreva a descrição.'});
  }
  photoPath='/uploads/proofs/'+req.file.filename;
  savedProof='Fotografia e descrição enviadas';
 }
 else{
  if(req.file) fs.unlinkSync(req.file.path);
  return res.status(400).json({error:'Escolha o tipo de comprovativo.'});
 }

 const previous=db.prepare(`
  SELECT id,status FROM submissions
  WHERE user=? AND task=?
  ORDER BY id DESC LIMIT 1
 `).get(req.user.id,task.id);

 if(previous && previous.status!=='rejected'){
  if(req.file) fs.unlinkSync(req.file.path);
  return res.status(409).json({
   error:previous.status==='approved'
    ?'Esta tarefa já foi aprovada.'
    :'Já existe uma prova pendente de análise.'
  });
 }

 db.prepare(`
  INSERT INTO submissions
  (user,task,proof,reward,proofType,photoPath,description)
  VALUES(?,?,?,?,?,?,?)
 `).run(
  req.user.id,task.id,savedProof,task.reward,
  proofType,photoPath,description||null
 );

 res.json({ok:true,message:'Comprovativo enviado para aprovação.'});
}));

app.get('/api/my-submissions',auth,wrap(async(req,res)=>{
 const items=db.prepare(`
  SELECT s.*,t.title AS taskTitle,
   CASE WHEN s.id=(
    SELECT MAX(s2.id)
    FROM submissions s2
    WHERE s2.user=s.user AND s2.task=s.task
   ) THEN 1 ELSE 0 END AS isLatest
  FROM submissions s
  LEFT JOIN tasks t ON t.id=s.task
  WHERE s.user=?
  ORDER BY s.id DESC
 `).all(req.user.id).map(s=>({
  ...s,
  task:s.task?{id:s.task,title:s.taskTitle}:null
 }));

 const accepted=db.prepare(`
  SELECT a.task,a.createdAt,t.title,t.description,t.reward
  FROM task_acceptances a
  JOIN tasks t ON t.id=a.task
  LEFT JOIN submissions s
   ON s.task=a.task AND s.user=a.user
  WHERE a.user=? AND s.id IS NULL
  ORDER BY a.createdAt DESC
 `).all(req.user.id);

 for(const a of accepted){
  items.push({
   task:a.task,
   taskTitle:a.title,
   task:{id:a.task,title:a.title},
   description:a.description,
   reward:a.reward,
   status:'accepted',
   createdAt:a.createdAt,
   proofType:null
  });
 }

 res.json({items});
}));

/* LEVANTAMENTOS */

app.post('/api/withdrawals',auth,wrap(async(req,res)=>{
 const amount=mt(req.body.amount);
 const method=req.body.method;
 const phone=String(req.body.phone||'').replace(/\s/g,'');

 if(!Number.isFinite(amount)||amount<20)
  return res.status(400).json({
   error:'Mínimo de levantamento: 20 MT.'
  });

 if(!['M-Pesa','e-Mola'].includes(method) ||
 !/^[0-9]{9,15}$/.test(phone))
  return res.status(400).json({
   error:'Dados de pagamento inválidos.'
  });

 const fee=mt(amount*.10);
 const net=mt(amount-fee);

 const transaction=db.transaction(()=>{
  const u=db.prepare(`
   SELECT balance FROM users WHERE id=?
  `).get(req.user.id);

  if(!u || u.balance<amount)
   throw Error('Saldo insuficiente.');

  db.prepare(`
   UPDATE users SET balance=balance-? WHERE id=?
  `).run(amount,req.user.id);

  db.prepare(`
   INSERT INTO withdrawals
   (user,amount,fee,net,method,phone)
   VALUES(?,?,?,?,?,?)
  `).run(req.user.id,amount,fee,net,method,phone);
 });

 transaction();

 res.json({
  ok:true,
  message:`Pedido enviado. Valor líquido: ${net.toFixed(2)} MT.`
 });
}));

app.get('/api/withdrawals',auth,wrap(async(req,res)=>{
 let items;

 if(req.user.role==='admin'){
  items=db.prepare(`
   SELECT w.*,u.name AS userName,u.phone AS userPhone
   FROM withdrawals w
   JOIN users u ON u.id=w.user
   ORDER BY w.createdAt DESC
  `).all();
 }else{
  items=db.prepare(`
   SELECT * FROM withdrawals
   WHERE user=? ORDER BY createdAt DESC
  `).all(req.user.id);
 }

 items=items.map(w=>({
  ...w,
  user:w.userName ? {
   id:w.user,
   name:w.userName,
   phone:w.userPhone
  }:w.user
 }));

 res.json({items});
}));

/* SUPORTE */


app.post('/api/messages',auth,wrap(async(req,res)=>{
 const message=String(req.body.text||'').trim();

 if(!message||message.length>2000)
  return res.status(400).json({
   error:'Mensagem inválida.'
  });

 let target=req.user.id;

 if(req.user.role==='admin'&&req.body.userId){
  const u=db.prepare(`
   SELECT id FROM users WHERE id=? AND role='user'
  `).get(req.body.userId);

  if(!u)
   return res.status(404).json({
    error:'Utilizador não encontrado.'
   });

  target=u.id;
 }

 db.prepare(`
  INSERT INTO messages(user,sender,text)
  VALUES(?,?,?)
 `).run(
  target,
  req.user.role==='admin'?'admin':'user',
  message
 );

 if(req.user.role==='admin'&&target!==req.user.id){
  notifyUser(
   target,
   'Nova mensagem do MOZWORK',
   message,
   'message'
  );
 }

 res.json({ok:true});
}));

app.get('/api/messages',auth,wrap(async(req,res)=>{
 let items;

 if(req.user.role==='admin'){
  items=db.prepare(`
   SELECT m.*,u.name AS userName,u.phone AS userPhone
   FROM messages m
   JOIN users u ON u.id=m.user
   ORDER BY m.id ASC
  `).all();
 }else{
  items=db.prepare(`
   SELECT * FROM messages
   WHERE user=? ORDER BY id ASC
  `).all(req.user.id);

  db.prepare(`
   UPDATE messages SET read=1
   WHERE user=? AND sender='admin'
  `).run(req.user.id);
 }

 res.json({
  items:items.map(m=>({
   ...m,
   user:m.userName ? {
    id:m.user,
    name:m.userName,
    phone:m.userPhone
   }:m.user
  }))
 });
}));

/* ADMINISTRAÇÃO */ 
/* ADMINISTRAÇÃO */

app.get('/api/admin/summary',auth,admin,wrap(async(req,res)=>{
 const count=sql=>db.prepare(sql).get().total;

 res.json({
  users:count("SELECT COUNT(*) AS total FROM users WHERE role='user'"),
  tasks:count("SELECT COUNT(*) AS total FROM tasks"),
  pendingSubmissions:count("SELECT COUNT(*) AS total FROM submissions WHERE status='pending'"),
  pendingWithdrawals:count("SELECT COUNT(*) AS total FROM withdrawals WHERE status='pending'"),
  messages:count("SELECT COUNT(*) AS total FROM messages WHERE read=0")
 });
}));

app.get('/api/admin/users',auth,admin,wrap(async(req,res)=>{
 const items=db.prepare(`
  SELECT id,name,phone,role,balance,blocked,createdAt
  FROM users WHERE role='user'
  ORDER BY createdAt DESC
 `).all();

 res.json({items});
}));

app.patch('/api/admin/users/:id',auth,admin,wrap(async(req,res)=>{
 const result=db.prepare(`
  UPDATE users SET blocked=? WHERE id=? AND role='user'
 `).run(req.body.blocked?1:0,req.params.id);

 if(!result.changes)
  return res.status(404).json({
   error:'Utilizador não encontrado.'
  });

 const u=db.prepare(`
  SELECT id,name,phone,role,balance,blocked
  FROM users WHERE id=?
 `).get(req.params.id);

 res.json({user:safe(u)});
}));


app.post('/api/admin/tasks',auth,admin,wrap(async(req,res)=>{
 const title=String(req.body.title||'').trim();
 const description=String(req.body.description||'').trim();
 const reward=mt(req.body.reward);

 if(title.length<3||!description||
 !Number.isFinite(reward)||reward<=0)
  return res.status(400).json({
   error:'Dados da tarefa inválidos.'
  });

 const publishedAt=req.body.publishedAt?
  new Date(req.body.publishedAt).toISOString():
  new Date().toISOString();

 const expiresAt=req.body.expiresAt?
  new Date(req.body.expiresAt).toISOString():null;

 const result=db.prepare(`
  INSERT INTO tasks
  (title,description,reward,slots,publishedAt,expiresAt)
  VALUES(?,?,?,?,?,?)
 `).run(
  title,
  description,
  reward,
  Math.max(0,Number(req.body.slots)||0),
  publishedAt,
  expiresAt
 );

 const task=db.prepare(
  'SELECT * FROM tasks WHERE id=?'
 ).get(result.lastInsertRowid);

 notifyAll(
  'Nova tarefa disponível',
  'Foi publicada uma nova tarefa: '+title,
  'task'
 );

 res.json({task});
}));

app.get('/api/admin/tasks',auth,admin,wrap(async(req,res)=>{
 const items=db.prepare(`
  SELECT * FROM tasks ORDER BY createdAt DESC
 `).all();

 res.json({items});
}));

app.patch('/api/admin/tasks/:id',auth,admin,wrap(async(req,res)=>{
 const fields=[];
 const values=[];

 for(const k of ['title','description','active','reward','slots']){
  if(req.body[k]!==undefined){
   fields.push(k+'=?');

   let value=req.body[k];

   if(k==='active')value=value?1:0;
   if(k==='reward')value=mt(value);

   values.push(value);
  }
 }

 if(!fields.length)
  return res.status(400).json({
   error:'Nenhuma alteração enviada.'
  });

 values.push(req.params.id);

 const result=db.prepare(`
  UPDATE tasks SET ${fields.join(',')}
  WHERE id=?
 `).run(...values);

 if(!result.changes)
  return res.status(404).json({
   error:'Tarefa não encontrada.'
  });

 res.json({
  task:db.prepare('SELECT * FROM tasks WHERE id=?')
   .get(req.params.id)
 });
}));

app.delete('/api/admin/tasks/:id',auth,admin,wrap(async(req,res)=>{
 db.prepare(`
  UPDATE tasks SET active=0 WHERE id=?
 `).run(req.params.id);

 res.json({ok:true});
}));

app.get('/api/admin/submissions',auth,admin,wrap(async(req,res)=>{
 const items=db.prepare(`
  SELECT s.*,
   u.name AS userName,
   u.phone AS userPhone,
   t.title AS taskTitle
  FROM submissions s
  LEFT JOIN users u ON u.id=s.user
  LEFT JOIN tasks t ON t.id=s.task
  ORDER BY s.createdAt DESC
 `).all().map(s=>({
  ...s,
  user:{
   id:s.user,
   name:s.userName,
   phone:s.userPhone
  },
  task:{
   id:s.task,
   title:s.taskTitle
  }
 }));

 res.json({items});
}));


app.patch('/api/admin/submissions/:id',auth,admin,wrap(async(req,res)=>{
 const status=req.body.status;

 if(!['approved','rejected'].includes(status))
  return res.status(400).json({
   error:'Decisão inválida.'
  });

 let reviewedSubmission=null;

 const transaction=db.transaction(()=>{
  const sub=db.prepare(`
   SELECT * FROM submissions
   WHERE id=? AND status='pending'
  `).get(req.params.id);

  if(!sub)
   throw Error('Prova já analisada ou inexistente.');

  reviewedSubmission=sub;

  db.prepare(`
   UPDATE submissions SET status=? WHERE id=?
  `).run(status,sub.id);

  if(status==='approved'){
   db.prepare(`
    UPDATE users SET balance=balance+? WHERE id=?
   `).run(sub.reward,sub.user);
  }
 });

 transaction();

 if(reviewedSubmission){
  if(status==='approved'){
   notifyUser(
    reviewedSubmission.user,
    'Comprovativo aprovado',
    'O teu comprovativo foi aprovado! '+Number(reviewedSubmission.reward).toFixed(2)+' MT foram adicionados ao teu saldo.',
    'proof'
   );
  }else{
   notifyUser(
    reviewedSubmission.user,
    'Comprovativo rejeitado',
    'O teu comprovativo foi rejeitado. Consulta a tarefa ou contacta o suporte para mais informações.',
    'proof'
   );
  }
 }

 res.json({ok:true});
}));


app.patch('/api/admin/withdrawals/:id',auth,admin,wrap(async(req,res)=>{
 const status=req.body.status;

 if(!['paid','rejected'].includes(status))
  return res.status(400).json({
   error:'Estado inválido.'
  });

 let reviewedWithdrawal=null;

 const transaction=db.transaction(()=>{
  const w=db.prepare(`
   SELECT * FROM withdrawals
   WHERE id=? AND status='pending'
  `).get(req.params.id);

  if(!w)
   throw Error('Pedido já analisado.');

  reviewedWithdrawal=w;

  db.prepare(`
   UPDATE withdrawals SET status=? WHERE id=?
  `).run(status,w.id);

  if(status==='rejected'){
   db.prepare(`
    UPDATE users SET balance=balance+? WHERE id=?
   `).run(w.amount,w.user);
  }
 });

 transaction();

 if(reviewedWithdrawal){
  if(status==='paid'){
   notifyUser(
    reviewedWithdrawal.user,
    'Levantamento aprovado',
    'O teu levantamento foi marcado como pago pela administração.',
    'withdrawal'
   );
  }else{
   notifyUser(
    reviewedWithdrawal.user,
    'Levantamento rejeitado',
    'O teu levantamento foi rejeitado. O valor foi devolvido ao teu saldo.',
    'withdrawal'
   );
  }
 }

 res.json({ok:true});
}));


app.get('/api/admin/messages',auth,admin,wrap(async(req,res)=>{
 const userId=Number(req.query.userId||0);

 if(userId){
  const user=db.prepare(`
   SELECT id,name,phone FROM users
   WHERE id=? AND role='user'
  `).get(userId);

  if(!user)
   return res.status(404).json({
    error:'Utilizador não encontrado.'
   });

  const items=db.prepare(`
   SELECT * FROM messages
   WHERE user=? ORDER BY id ASC
  `).all(userId);

  db.prepare(`
   UPDATE messages SET read=1
   WHERE user=? AND sender='user'
  `).run(userId);

  return res.json({user,items});
 }

 const items=db.prepare(`
  SELECT
   u.id AS userId,
   u.name AS userName,
   u.phone AS userPhone,
   MAX(m.id) AS lastId,
   (SELECT text FROM messages
    WHERE user=u.id ORDER BY id DESC LIMIT 1) AS lastMessage,
   (SELECT sender FROM messages
    WHERE user=u.id ORDER BY id DESC LIMIT 1) AS lastSender,
   (SELECT createdAt FROM messages
    WHERE user=u.id ORDER BY id DESC LIMIT 1) AS lastAt,
   COALESCE(SUM(
    CASE WHEN m.sender='user' AND m.read=0
    THEN 1 ELSE 0 END
   ),0) AS unread
  FROM users u
  LEFT JOIN messages m ON m.user=u.id
  WHERE u.role='user'
  GROUP BY u.id,u.name,u.phone
  ORDER BY COALESCE(MAX(m.id),0) DESC,u.id DESC
 `).all();

 res.json({items});
}));

/* BOTS DE PUBLICAÇÃO AUTOMÁTICA */
/* BOTS DE PUBLICAÇÃO AUTOMÁTICA */

app.get('/api/admin/bots',auth,admin,wrap(async(req,res)=>{
 const items=db.prepare('SELECT * FROM bots ORDER BY id DESC').all();
 res.json({items});
}));

app.post('/api/admin/bots',auth,admin,wrap(async(req,res)=>{
 const name=String(req.body.name||'').trim();
 const title=String(req.body.title||'').trim();
 const description=String(req.body.description||'').trim();
 const reward=mt(req.body.reward);
 const interval=Math.max(1,Math.min(1440,Number(req.body.intervalMinutes)||10));
 const quantity=Math.max(1,Math.min(10000,Number(req.body.quantity)||1));
 const slots=Math.max(0,Number(req.body.slots)||0);

 if(name.length<2||title.length<3||!description||
 !Number.isFinite(reward)||reward<=0)
  return res.status(400).json({error:'Preencha correctamente os dados do bot.'});

 let nextRun=new Date().toISOString();
 if(req.body.startAt){
  const d=new Date(req.body.startAt);
  if(Number.isNaN(d.getTime()))
   return res.status(400).json({error:'Data de início inválida.'});
  nextRun=d.toISOString();
 }

 const r=db.prepare(`
  INSERT INTO bots(name,title,description,reward,slots,intervalMinutes,remaining,nextRun)
  VALUES(?,?,?,?,?,?,?,?)
 `).run(name,title,description,reward,slots,interval,quantity,nextRun);

 res.json({ok:true,bot:db.prepare('SELECT * FROM bots WHERE id=?').get(r.lastInsertRowid)});
}));

app.patch('/api/admin/bots/:id',auth,admin,wrap(async(req,res)=>{
 const bot=db.prepare('SELECT * FROM bots WHERE id=?').get(req.params.id);
 if(!bot)return res.status(404).json({error:'Bot não encontrado.'});

 if(req.body.active!==undefined){
  db.prepare('UPDATE bots SET active=? WHERE id=?')
   .run(req.body.active?1:0,bot.id);
 }
 if(req.body.remaining!==undefined){
  const n=Math.max(0,Number(req.body.remaining)||0);
  db.prepare('UPDATE bots SET remaining=? WHERE id=?').run(n,bot.id);
 }
 res.json({ok:true});
}));

app.delete('/api/admin/bots/:id',auth,admin,wrap(async(req,res)=>{
 db.prepare('DELETE FROM bots WHERE id=?').run(req.params.id);
 res.json({ok:true});
}));

/* MOTOR AUTOMÁTICO DOS BOTS */
let botRunning=false;

setInterval(()=>{
 if(botRunning)return;
 botRunning=true;
 try{
  const now=new Date().toISOString();
  const due=db.prepare(`
   SELECT * FROM bots
   WHERE active=1 AND remaining>0 AND nextRun<=?
   ORDER BY nextRun ASC LIMIT 20
  `).all(now);

  for(const bot of due){
   const transaction=db.transaction(()=>{
    const current=db.prepare(
     'SELECT * FROM bots WHERE id=? AND active=1 AND remaining>0 AND nextRun<=?'
    ).get(bot.id,now);
    if(!current)return;

    const published=new Date().toISOString();
    db.prepare(`
     INSERT INTO tasks(title,description,reward,slots,publishedAt,active)
     VALUES(?,?,?,?,?,1)
    `).run(current.title,current.description,current.reward,current.slots,published);

    const left=current.remaining-1;
    const next=new Date(Date.now()+current.intervalMinutes*60000).toISOString();

    db.prepare(`
     UPDATE bots SET remaining=?,active=?,nextRun=? WHERE id=?
    `).run(left,left>0?1:0,next,current.id);
   });
   transaction();
   console.log('BOT '+bot.name+': tarefa publicada.');
  }
 }catch(e){
  console.error('Erro no motor dos bots:',e.message);
 }finally{
  botRunning=false;
 }
},15000);



/* PUBLICIDADE MOZWORK */

app.get('/api/ads',wrap(async(req,res)=>{
 const now=new Date().toISOString();
 const items=db.prepare(`
  SELECT id,title,description,imageUrl,targetUrl
  FROM ads
  WHERE active=1 AND startAt<=? AND endAt>?
  ORDER BY id DESC
 `).all(now,now);

 for(const ad of items){
  db.prepare('UPDATE ads SET impressions=impressions+1 WHERE id=?').run(ad.id);
 }
 res.json({items});
}));

app.get('/api/ads/:id/click',wrap(async(req,res)=>{
 const ad=db.prepare(`
  SELECT targetUrl FROM ads
  WHERE id=? AND active=1
  AND startAt<=? AND endAt>?
 `).get(req.params.id,new Date().toISOString(),new Date().toISOString());

 if(!ad)return res.status(404).json({error:'Anúncio indisponível.'});
 db.prepare('UPDATE ads SET clicks=clicks+1 WHERE id=?').run(req.params.id);
 res.json({url:ad.targetUrl});
}));

app.post('/api/ad-requests',wrap(async(req,res)=>{
 const company=String(req.body.company||'').trim();
 const phone=String(req.body.phone||'').trim();
 const title=String(req.body.title||'').trim();
 const description=String(req.body.description||'').trim();
 const imageUrl=String(req.body.imageUrl||'').trim();
 const targetUrl=String(req.body.targetUrl||'').trim();

 if(company.length<2||phone.length<9||title.length<3||
 !/^https?:\/\/\S+/i.test(targetUrl))
  return res.status(400).json({error:'Preencha correctamente os dados e o link do anúncio.'});

 if(imageUrl && !/^https?:\/\/\S+/i.test(imageUrl))
  return res.status(400).json({error:'O endereço da imagem deve começar por http:// ou https://.'});

 db.prepare(`
  INSERT INTO ad_requests(company,phone,title,description,imageUrl,targetUrl)
  VALUES(?,?,?,?,?,?)
 `).run(company,phone,title,description,imageUrl,targetUrl);

 res.json({ok:true,message:'Pedido de publicidade enviado. Aguarde o contacto da MOZWORK.'});
}));

app.get('/api/admin/ads',auth,admin,wrap(async(req,res)=>{
 res.json({items:db.prepare('SELECT * FROM ads ORDER BY id DESC').all()});
}));

app.post('/api/admin/ads',auth,admin,adUpload.single('image'),wrap(async(req,res)=>{
 const title=String(req.body.title||'').trim();
 const description=String(req.body.description||'').trim();
 const imageUrl=req.file?'/uploads/ads/'+req.file.filename:String(req.body.imageUrl||'').trim();
 const targetUrl=String(req.body.targetUrl||'').trim();
 const start=new Date(req.body.startAt);
 const end=new Date(req.body.endAt);

 if(title.length<3||!/^https?:\/\/\S+/i.test(targetUrl)||
 Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start){
  if(req.file)fs.unlinkSync(req.file.path);
  return res.status(400).json({error:'Dados ou datas da campanha inválidos.'});
 }

 if(imageUrl && !imageUrl.startsWith('/uploads/ads/') && !/^https?:\/\/\S+/i.test(imageUrl)){
  if(req.file)fs.unlinkSync(req.file.path);
  return res.status(400).json({error:'Link da imagem inválido.'});
 }

 const r=db.prepare(`
  INSERT INTO ads(title,description,imageUrl,targetUrl,startAt,endAt)
  VALUES(?,?,?,?,?,?)
 `).run(title,description,imageUrl,targetUrl,start.toISOString(),end.toISOString());

 res.json({ok:true,id:r.lastInsertRowid});
}));

app.patch('/api/admin/ads/:id',auth,admin,adUpload.single('image'),wrap(async(req,res)=>{
 const ad=db.prepare('SELECT * FROM ads WHERE id=?').get(req.params.id);
 if(!ad)return res.status(404).json({error:'Campanha não encontrada.'});

 if(typeof req.body.active !== 'undefined' &&
    !Object.keys(req.body).some(k=>['title','description','imageUrl','targetUrl','startAt','endAt'].includes(k))){
  db.prepare('UPDATE ads SET active=? WHERE id=?')
   .run(req.body.active?1:0,req.params.id);
  return res.json({ok:true});
 }

 const title=String(req.body.title??ad.title).trim();
 const description=String(req.body.description??ad.description??'').trim();
 const imageUrl=req.file?'/uploads/ads/'+req.file.filename:String(req.body.imageUrl??ad.imageUrl??'').trim();
 const targetUrl=String(req.body.targetUrl??ad.targetUrl).trim();
 const start=new Date(req.body.startAt??ad.startAt);
 const end=new Date(req.body.endAt??ad.endAt);

 if(title.length<3 || !/^https?:\/\/\S+/i.test(targetUrl) ||
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end<=start)
  return res.status(400).json({error:'Dados ou datas da campanha inválidos.'});

 if(imageUrl && !/^https?:\/\/\S+/i.test(imageUrl))
  return res.status(400).json({error:'Link da imagem inválido.'});

 db.prepare(`UPDATE ads SET title=?,description=?,imageUrl=?,targetUrl=?,startAt=?,endAt=? WHERE id=?`)
  .run(title,description,imageUrl,targetUrl,start.toISOString(),end.toISOString(),req.params.id);

 res.json({ok:true});
}));

app.delete('/api/admin/ads/:id',auth,admin,wrap(async(req,res)=>{
 db.prepare('DELETE FROM ads WHERE id=?').run(req.params.id);
 res.json({ok:true});
}));

app.get('/api/admin/ad-requests',auth,admin,wrap(async(req,res)=>{
 res.json({items:db.prepare('SELECT * FROM ad_requests ORDER BY id DESC').all()});
}));

app.patch('/api/admin/ad-requests/:id',auth,admin,wrap(async(req,res)=>{
 const status=req.body.status;
 if(!['approved','rejected'].includes(status))
  return res.status(400).json({error:'Estado inválido.'});

 const r=db.prepare('SELECT * FROM ad_requests WHERE id=? AND status=?')
  .get(req.params.id,'pending');
 if(!r)return res.status(404).json({error:'Pedido não encontrado ou já analisado.'});

 const tx=db.transaction(()=>{
  if(status==='approved'){
   const days=Number(req.body.durationDays||30);
   if(!Number.isInteger(days)||days<1||days>365)
    throw new Error('A duração deve ser entre 1 e 365 dias.');

   const start=new Date().toISOString();
   const end=new Date(Date.now()+days*86400000).toISOString();

   db.prepare(`
    INSERT INTO ads(title,description,imageUrl,targetUrl,startAt,endAt)
    VALUES(?,?,?,?,?,?)
   `).run(r.title,r.description,r.imageUrl,r.targetUrl,start,end);
  }
  db.prepare('UPDATE ad_requests SET status=? WHERE id=?').run(status,r.id);
 });
 tx();
 res.json({ok:true});
}));


/* PAINEL ADMINISTRATIVO INDEPENDENTE */
app.get('/admin', (req,res)=>{
 res.sendFile(path.join(__dirname,'public','admin.html'));
});

/* PÁGINA PRINCIPAL */

app.get(/.*/, (req,res)=>{
 res.sendFile(path.join(__dirname,'public','index.html'));
});

/* ERROS */

app.use((err,req,res,next)=>{
 console.error(err);

 res.status(500).json({
  error:err.message||'Erro interno.'
 });
});

/* INICIALIZAÇÃO */

async function start(){
 let admin = db.prepare(
  "SELECT * FROM users WHERE role='admin' LIMIT 1"
 ).get();

 if(!admin){
  const crypto = require('crypto');
  const phone = 'MOZWORK-ADMIN-' + crypto.randomBytes(16).toString('hex');
  const internalPassword = crypto.randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(internalPassword, 12);

  db.prepare(`
   INSERT INTO users(name,phone,passwordHash,role,blocked)
   VALUES(?,?,?,'admin',0)
  `).run('Administrador', phone, hash);

  console.log('Conta administrativa criada.');
 }else if(admin.blocked){
  db.prepare(
   "UPDATE users SET blocked=0 WHERE id=?"
  ).run(admin.id);
  console.log('Conta administrativa reactivada.');
 }

 const port=process.env.PORT||3000;

 app.listen(port,'0.0.0.0',()=>{
  console.log('================================');
  console.log('       MOZWORK MZ');
  console.log('================================');
  console.log('Base de dados: SQLite');
  console.log('Servidor activo na porta '+port);
  console.log('http://localhost:'+port);
  console.log('================================');
 });
}

start().catch(e=>{
 console.error('Erro ao iniciar:',e);
 process.exit(1);
});


}

boot().catch(error=>{
 console.error('Erro ao iniciar MOZWORK:',error);
 process.exit(1);
});
