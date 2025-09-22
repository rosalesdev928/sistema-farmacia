// index.js
import express           from 'express';
import cors              from 'cors';
import mysql             from 'mysql2/promise';
import path              from 'path';
import { fileURLToPath } from 'url';
import { body, validationResult } from 'express-validator';


// Esto permite usar __dirname en un módulo ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);


const app = express();
app.use(cors());
app.use(express.json());

// — AUMENTA EL LÍMITE DE JSON y URL-ENCODED — 
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// ❌ No cache para HTML (login, index, etc.)
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});


// ─── OPCIONAL: CAPTURAR ERROR 413 PARA QUE DEVUELVA JSON ───
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Imagen demasiado grande' });
  }
  next(err);
});
// Servir /favicons desde dist/favicons
app.use('/favicons', express.static(path.join(__dirname, 'dist', 'favicons')));



// Pool de conexiones MySQL
const pool = mysql.createPool({
  host:               process.env.DB_HOST || '127.0.0.1',
  user:               process.env.DB_USER || 'leo',
  password:           process.env.DB_PASSWORD || 'leitodevbd',
  database:           process.env.DB_NAME || 'bd_farmacia_leo',
  port:               Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0
});

// Helper para enviar HTML con no-store
function sendHtml(res, file) {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'dist', file));
}
// Formatea YYYY-MM-DD
function toYMD(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}




// — RUTAS CRUD —
app.get('/',               (req, res) => sendHtml(res, 'index.html'));
app.get('/users', async (req, res) => {
  try {
    // Parámetros DataTables
    const draw   = parseInt(req.query.draw,10) || 0;
    const page   = parseInt(req.query.page,10) || 1;
    const size   = parseInt(req.query.size,10) || 10;
    const search = req.query.search   || '';
    const sortBy = req.query.sortBy   || 'u.id';
    const order  = (req.query.order||'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    // 1) Total sin filtrar
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM usuarios`);
    // 2) Construir WHERE de búsqueda
    let where = '';
    const params = [];
    if (search) {
        where = `WHERE 
        CAST(u.id AS CHAR)      LIKE ? OR
        u.username              LIKE ? OR
        u.nombreCompleto        LIKE ? OR
        u.email                 LIKE ? OR
        u.dni                   LIKE ?`;
      const like = `%${search}%`;
      // añadimos el mismo patrón para cada columna
      params.push(like, like, like, like, like);
    }
    // 3) Consulta principal con JOIN y paginado
    const offset = (page - 1) * size;
    const sql = `
      SELECT 
        u.id,
        u.username,
        u.nombreCompleto,
        u.celular,
        u.email,
        u.password,
        u.dni,
        u.direccion,
        p.rol AS rol
      FROM usuarios AS u
      LEFT JOIN perfil AS p
        ON u.idPerfil = p.id
      ${where}
      ORDER BY ${mysql.escapeId(sortBy)} ${order}
      LIMIT ? OFFSET ?`;
    params.push(size, offset);

    const [rows] = await pool.query(sql, params);

     // 4) Cuenta filtrada
    let recordsFiltered = total;
    if (search) {
      // volvemos a contar filas según el mismo WHERE (sin LIMIT)
      const [[{ cnt }]] = await pool.query(
        `SELECT COUNT(*) AS cnt
         FROM usuarios u
         LEFT JOIN perfil p ON u.idPerfil = p.id
         ${where}`,
        params.slice(0, -2)
      );
      recordsFiltered = cnt;
    }

    // 5) Responder en formato DataTables
    res.json({
      draw,
      recordsTotal:    total,
      recordsFiltered,
      data:            rows
    });

  } catch (err) {
    console.error('❌ Error en GET /users:', err);
    res.status(500).json({ error: 'Error en base de datos' });
  }
});

// GET /users/:id  → Obtener uno
app.get('/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query(`
      SELECT id, username, nombreCompleto, celular, email,
             password, dni, direccion
      FROM usuarios WHERE id = ?
    `, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en base de datos' });
  }
});


// 🚀 RUTA para obtener todos los roles
//
app.get('/api/roles', async (req, res) => {
  try {
    // Ejecuta la consulta y obtén filas
    const [roles] = await pool.query('SELECT id, rol FROM perfil');
    // Devuélvelas como JSON
    res.json(roles);
  } catch (err) {
    console.error('Error al obtener roles:', err);
    res.status(500).json({ error: 'Error al obtener roles' });
  }
});


// POST /users/create  → Crear un nuevo usuario con validación y control de duplicados, incluyendo idPerfil
app.post(
  '/users/create',
  // 1) Middleware de validación de formato
  [
    body('email')
      .isEmail()
      .withMessage('Email inválido'),
    body('dni')
      .matches(/^[0-9]{8}$/)
      .withMessage('El DNI debe ser exactamente 8 dígitos numéricos'),
    body('username')
      .notEmpty()
      .withMessage('El nombre de usuario es obligatorio'),
    body('nombreCompleto')
      .notEmpty()
      .withMessage('El nombre completo es obligatorio'),
    body('celular')
      .notEmpty()
      .withMessage('El celular es obligatorio'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('La contraseña debe tener al menos 6 caracteres'),
    body('idPerfil')
      .isInt({ min: 1 })
      .withMessage('Debe seleccionar un rol válido')
  ],
  // 2) Middleware que revisa el resultado de express-validator
  (req, res, next) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) {
      return res.status(400).json({ errors: errs.array() });
    }
    next();
  },
  // 3) Controlador que comprueba duplicados, inserta y captura errores de MySQL
  async (req, res) => {
    const {
      username,
      nombreCompleto,
      celular,
      email,
      password,
      dni,
      direccion,
      idPerfil
    } = req.body;

    try {
      // 3.1) Pre-check de duplicados en email o DNI
      const [confPD] = await pool.query(
        `SELECT id, email, dni
           FROM usuarios
          WHERE email = ? OR dni = ?`,
        [email, dni]
      );
      if (confPD.length) {
        const c = confPD[0];
        if (c.email === email) {
          return res.status(400).json({ error: 'El email ya está registrado' });
        }
        if (c.dni === dni) {
          return res.status(400).json({ error: 'El DNI ya está registrado' });
        }
      }

      // 3.2) Inserción en la base de datos, ahora con idPerfil
      const [result] = await pool.query(
        `INSERT INTO usuarios
          (username, nombreCompleto, celular, email, password, dni, direccion, idPerfil)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [username, nombreCompleto, celular, email, password, dni, direccion, idPerfil]
      );

      // 3.3) Respuesta con el nuevo usuario
      res.status(201).json({
        id:            result.insertId,
        username,
        nombreCompleto,
        celular,
        email,
        dni,
        direccion,
        idPerfil
      });
    } catch (err) {
      // 3.4) Captura de violaciones de UNIQUE (ER_DUP_ENTRY) en MySQL
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'Email o DNI ya registrado' });
      }
      console.error('❌ Error en POST /users/create:', err);
      res.status(500).json({ error: 'Error al crear usuario' });
    }
  }
);

// PUT /users/:id  — Actualizar un usuario existente con validación y control de duplicados
app.put(
  '/users/:id',

  // 1) Middleware de validación de formato
  [
    body('email')
      .isEmail()
      .withMessage('Email inválido'),
    body('dni')
      .matches(/^[0-9]{8}$/)
      .withMessage('El DNI debe ser exactamente 8 dígitos numéricos'),
    body('username')
      .notEmpty()
      .withMessage('El nombre de usuario es obligatorio'),
    body('nombreCompleto')
      .notEmpty()
      .withMessage('El nombre completo es obligatorio'),
    body('celular')
      .notEmpty()
      .withMessage('El celular es obligatorio'),
    body('idPerfil')
      .isInt({ min: 1 })
      .withMessage('Debe seleccionar un rol válido'),
  ],

  // 2) Middleware que comprueba errores de express-validator
  (req, res, next) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) {
      return res.status(400).json({ errors: errs.array() });
    }
    next();
  },

  // 3) Controlador principal
  async (req, res) => {
    const id = Number(req.params.id);
    const {
      username,
      nombreCompleto,
      celular,
      email,
      password,
      dni,
      direccion,
      idPerfil
    } = req.body;

    try {
      // 3.1) Pre-check de duplicados en email o DNI, excluyendo al propio usuario
      const [confPD] = await pool.query(
        `SELECT id, email, dni
           FROM usuarios
          WHERE (email = ? OR dni = ?)
            AND id <> ?`,
        [email, dni, id]
      );
      if (confPD.length) {
        const c = confPD[0];
        if (c.email === email) {
          return res.status(400).json({ error: 'El email ya está registrado por otro usuario' });
        }
        if (c.dni === dni) {
          return res.status(400).json({ error: 'El DNI ya está registrado por otro usuario' });
        }
      }

      // 3.2) Actualizar en la base de datos, incluyendo idPerfil
      const [result] = await pool.query(
        `UPDATE usuarios SET
           username       = ?,
           nombreCompleto = ?,
           celular        = ?,
           email          = ?,
           password       = ?,
           dni            = ?,
           direccion      = ?,
           idPerfil       = ?
         WHERE id = ?`,
        [username, nombreCompleto, celular, email, password, dni, direccion, idPerfil, id]
      );
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
      }

      // 3.3) Devolver el registro ya actualizado (incluyendo idPerfil)
      const [rows] = await pool.query(
        `SELECT 
           u.id,
           u.username,
           u.nombreCompleto,
           u.celular,
           u.email,
           u.password,
           u.dni,
           u.direccion,
           u.idPerfil,
           p.rol AS nombreRol
         FROM usuarios u
         LEFT JOIN perfil p ON u.idPerfil = p.id
         WHERE u.id = ?`,
        [id]
      );
      res.json(rows[0]);

    } catch (err) {
      // 3.4) Captura de violaciones de UNIQUE
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ error: 'Ya existe un usuario con ese email o DNI' });
      }
      console.error('❌ Error en PUT /users/:id:', err);
      res.status(500).json({ error: 'Error al actualizar usuario' });
    }
  }
);

// DELETE /users/:id  → Eliminar un usuario
app.delete('/users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [result] = await pool.query(`DELETE FROM usuarios WHERE id = ?`, [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ message: 'Usuario eliminado correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar usuario' });
  }
});

// PATCH /users/:id/password  → Actualizar sólo la contraseña
app.patch('/users/:id/password', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { password } = req.body;
    const [result] = await pool.query(
      `UPDATE usuarios SET password = ? WHERE id = ?`,
      [password, id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }
    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar contraseña' });
  }
});
// Ejemplo de /login (ilustrativo)
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  const sql = `
    SELECT u.id, u.username, u.nombreCompleto, u.celular, u.email,
           u.dni, u.direccion, u.idPerfil AS perfilId,
           p.rol, p.accesos
    FROM usuarios u
    JOIN perfil p ON p.id = u.idPerfil
    WHERE u.username = ? AND u.password = ?
    LIMIT 1
  `;
  try {
    const [rows] = await pool.query(sql, [username, password]);
    if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });

    const user = rows[0];
    // Parsear el JSON que viene de MySQL
let accesos = [];
try { accesos = JSON.parse(user.accesos || '[]'); } catch { accesos = []; }

// (Opcional) también genera un arreglo "plano" de strings para compatibilidad
const accesosPlano = accesos
  .filter(a => a && a.acceso === true)
  .map(a => String(a.modulo || '').toUpperCase()); // ['USUARIOS','CLIENTES',...]

return res.json({
  message: 'Bienvenido',
  user: {
    id: user.id,
    username: user.username,
    nombreCompleto: user.nombreCompleto,
    celular: user.celular,
    email: user.email,
    dni: user.dni,
    direccion: user.direccion,
    perfilId: user.perfilId,
    rol: user.rol,
    accesos,        // ← array de objetos (el que quieres en localStorage)
    accesosPlano    // ← array de strings (por si tu front viejo lo necesita)
  }
});

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});


// — CRUD Clientes —
// Prefijo común: /api/clientes

// 1) Obtener un cliente por ID
app.get('/api/clientes/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [rows] = await pool.query(
      'SELECT * FROM clientes WHERE id = ?', [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 2) Listar / paginar / filtrar (DataTables)
app.get('/api/clientes', async (req, res) => {
  const draw   = Number(req.query.draw)   || 0;
  const page   = Number(req.query.page)   || 1;
  const size   = Number(req.query.size)   || 10;
  const search = req.query.search?.trim() || '';

  // columnas permitidas para ordenar
  const columns = ['id','dni','ruc','nombres','celular','direccion','correo'];
  let   sortBy  = columns.includes(req.query.sortBy) ? req.query.sortBy : 'id';
  const order   = req.query.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const offset = (page - 1) * size;
  const params = [];
  let   where  = '';

  if (search) {
    where = 'WHERE dni LIKE ? OR nombres LIKE ? OR correo LIKE ?';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  try {
    // total sin filtro
    const [[{ total }]]    = await pool.query('SELECT COUNT(*) AS total FROM clientes');
    // total con filtro
    const [[{ filtered }]] = await pool.query(
      `SELECT COUNT(*) AS filtered FROM clientes ${where}`, params
    );

    // datos paginados + ordenados
    const dataSQL = `
      SELECT id,dni,ruc,nombres,celular,direccion,correo
      FROM clientes
      ${where}
      ORDER BY \`${sortBy}\` ${order}
      LIMIT ? OFFSET ?
    `;
    const [data] = await pool.query(dataSQL, [...params, size, offset]);

    res.json({ draw, recordsTotal: total, recordsFiltered: filtered, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 3) Crear un nuevo cliente
app.post('/api/clientes', async (req, res) => {
  const { dni, ruc, nombres, celular, direccion, correo } = req.body;
  if (!dni || !nombres || !correo) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO clientes (dni,ruc,nombres,celular,direccion,correo)
       VALUES (?,?,?,?,?,?)`,
      [dni, ruc, nombres, celular, direccion, correo]
    );
    res.status(201).json({
      id: result.insertId,
      dni, ruc, nombres, celular, direccion, correo
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 4) Actualizar un cliente existente
app.put('/api/clientes/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { dni, ruc, nombres, celular, direccion, correo } = req.body;
  if (!dni || !nombres || !correo) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  try {
    const [result] = await pool.query(
      `UPDATE clientes
         SET dni=?, ruc=?, nombres=?, celular=?, direccion=?, correo=?
       WHERE id=?`,
      [dni, ruc, nombres, celular, direccion, correo, id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    res.json({ id, dni, ruc, nombres, celular, direccion, correo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 5) Eliminar un cliente
app.delete('/api/clientes/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [result] = await pool.query(
      'DELETE FROM clientes WHERE id = ?', [id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }
    res.json({ message: 'Cliente eliminado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});


// — CRUD Productos —
// 1) RUTA PARA DATATABLES SERVER-SIDE EN /productos
app.get('/api/productos', async (req, res) => {
  const draw    = Number(req.query.draw)   || 0;
  const page    = Number(req.query.page)   || 1;
  const size    = Number(req.query.size)   || 10;
  const search  = (req.query.search || '').trim();

  // Lista blanca de columnas ordenables
  const columns = ['id','nombre','categoria','cantidad','precio','foto'];
  const sortBy  = columns.includes(req.query.sortBy) ? req.query.sortBy : 'id';
  const order   = req.query.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const offset  = (page - 1) * size;

  // Construir WHERE dinámico
  let whereSQL = '';
  const params = [];
  if (search) {
    whereSQL = `WHERE nombre LIKE ? OR categoria LIKE ?`;
    params.push(`%${search}%`, `%${search}%`);
  }

  try {
    // Total sin filtrar
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM productos`
    );
    // Total con filtro
    const [[{ filtered }]] = await pool.query(
      `SELECT COUNT(*) AS filtered FROM productos ${whereSQL}`,
      params
    );
    // Datos paginados y ordenados
    const dataSQL = `
      SELECT id, nombre, categoria, cantidad, precio, foto
      FROM productos
      ${whereSQL}
      ORDER BY \`${sortBy}\` ${order}
      LIMIT ? OFFSET ?
    `;
    const [data] = await pool.query(dataSQL, [...params, size, offset]);

    // Responder en formato DataTables
    res.json({
      draw,
      recordsTotal:    total,
      recordsFiltered: filtered,
      data
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 2) RUTA PARA OBTENER UN PRODUCTO POR ID
app.get('/api/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [rows] = await pool.query(
      'SELECT id, nombre, categoria, cantidad, precio, foto FROM productos WHERE id = ?',
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// 3) RUTA PARA CREAR UN PRODUCTO
app.post('/api/productos', async (req, res) => {
  const { nombre, categoria, cantidad, precio, foto } = req.body;
  // validación básica
  if (!nombre || !categoria || cantidad == null || precio == null) {
    return res
      .status(400)
      .json({ error: 'Faltan campos obligatorios: nombre, categoría, cantidad o precio' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO productos (nombre, categoria, cantidad, precio, foto)
       VALUES (?, ?, ?, ?, ?)`,
      [nombre, categoria, cantidad, precio, foto]
    );
    res
      .status(201)
      .json({ id: result.insertId, nombre, categoria, cantidad, precio, foto });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

// 4) RUTA PARA ACTUALIZAR UN PRODUCTO
app.put('/api/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { nombre, categoria, cantidad, precio, foto } = req.body;
  if (!nombre || !categoria || cantidad == null || precio == null) {
    return res
      .status(400)
      .json({ error: 'Faltan campos obligatorios: nombre, categoría, cantidad o precio' });
  }
  try {
    const [result] = await pool.query(
      `UPDATE productos
         SET nombre   = ?,
             categoria= ?,
             cantidad = ?,
             precio   = ?,
             foto     = ?
       WHERE id = ?`,
      [nombre, categoria, cantidad, precio, foto, id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json({ id, nombre, categoria, cantidad, precio, foto });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

// 5) RUTA PARA ELIMINAR UN PRODUCTO
app.delete('/api/productos/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const [result] = await pool.query(
      'DELETE FROM productos WHERE id = ?',
      [id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    res.json({ message: 'Producto eliminado' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
});

// Servir los HTML estáticos
const PORT = process.env.PORT || 3000;

app.get('/clientes.html',  (req, res) => sendHtml(res, 'clientes.html'));
app.get('/productos.html', (req, res) => sendHtml(res, 'productos.html'));
app.get('/ventas.html',    (req, res) => sendHtml(res, 'ventas.html'));


// --- CRUD Ventas ---  (usar SIEMPRE /api/ventas)
app.get('/api/ventas', async (req, res) => {
  const draw   = Number(req.query.draw) || 0;
  const start  = Number(req.query.start) || 0;
  const length = Number(req.query.length) || 10;
  const search = (req.query['search[value]'] || '').trim();

  // columnas para ordenar (coinciden con las columnas del DataTable)
  const cols = [
    'v.id','c.nombres','c.correo','c.direccion',
    'v.fecha','v.numeroDoc','v.metodoPago','items','v.total'
  ];
  const orderColIdx = Number(req.query['order[0][column]']) || 0;
  const orderDir    = (req.query['order[0][dir]'] || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const orderBy     = cols[orderColIdx] || 'v.id';

  let where = '';
  const params = [];
  if (search) {
    where = `WHERE c.nombres LIKE ? OR c.correo LIKE ? OR c.direccion LIKE ? OR v.numeroDoc LIKE ?`;
    const q = `%${search}%`;
    params.push(q,q,q,q);
  }

  try {
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM ventas v
         JOIN clientes c ON v.idCliente = c.id`
    );

    const [[{ filtered }]] = await pool.query(
      `SELECT COUNT(*) AS filtered
         FROM ventas v
         JOIN clientes c ON v.idCliente = c.id
         ${where}`, params
    );

    const dataSQL = `
      SELECT
        v.id,
        c.nombres    AS cliente,
        c.correo,
        c.direccion,
        v.fecha,
        v.numeroDoc,
        v.metodoPago,
        v.total,
        COALESCE(it.items,0) AS items
      FROM ventas v
      JOIN clientes c ON v.idCliente = c.id
      LEFT JOIN (
        SELECT idVenta, COUNT(*) AS items
        FROM detalle_ventas
        GROUP BY idVenta
      ) it ON it.idVenta = v.id
      ${where}
      ORDER BY ${orderBy} ${orderDir}
      LIMIT ? OFFSET ?`;
    const [data] = await pool.query(dataSQL, [...params, length, start]);

    res.json({
      draw,
      recordsTotal: total,
      recordsFiltered: search ? filtered : total,
      data
    });
  } catch (err) {
    console.error('GET /api/ventas', err);
    res.status(500).json({ error: 'Error al listar ventas' });
  }
});
function normalizeFoto(f) {
  if (!f) return null;

  // Si ya viene como data URL, no tocamos nada
  const asStr = typeof f === 'string' ? f.trim() : null;
  if (asStr && asStr.startsWith('data:image/')) return asStr;

  // Detectar tipo por cabecera
  const toBase64 = (bufOrStr) => {
    if (Buffer.isBuffer(bufOrStr)) return bufOrStr.toString('base64');
    return String(bufOrStr).replace(/\s/g, '');
  };

  let b64 = '';
  let mime = 'image/jpeg'; // default

  if (Buffer.isBuffer(f)) {
    // Leer primeros bytes para detectar tipo
    const b = f;
    if (b.length >= 8) {
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) mime = 'image/png';
      else if (b[0] === 0xFF && b[1] === 0xD8) mime = 'image/jpeg';
      else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) mime = 'image/gif';
      else if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) mime = 'image/webp';
    }
    b64 = toBase64(f);
  } else {
    // String base64 "puro": detecta por prefijo base64
    const s = toBase64(f);
    if (s.startsWith('/9j/')) mime = 'image/jpeg';         // JPEG
    else if (s.startsWith('iVBORw0KGgo')) mime = 'image/png'; // PNG
    else if (s.startsWith('R0lGOD')) mime = 'image/gif';   // GIF
    else if (s.startsWith('UklGR')) mime = 'image/webp';   // WebP
    b64 = s;
  }

  return `data:${mime};base64,${b64}`;
}

app.get('/api/ventas/:id', async (req, res) => {
  const id = +req.params.id;
  try {
    const [[venta]] = await pool.query(
      `SELECT v.*, c.nombres AS cliente
         FROM ventas v
         JOIN clientes c ON v.idCliente = c.id
        WHERE v.id = ?`, [id]
    );
    if (!venta) return res.status(404).json({ error: 'Venta no encontrada' });

   // --- DETALLE con foto desde productos, SIN re-encode ---
const [rowsDet] = await pool.query(
  `SELECT dv.idProducto, p.nombre, p.foto, dv.cantidad, dv.precio
     FROM detalle_ventas dv
     JOIN productos p ON dv.idProducto = p.id
    WHERE dv.idVenta = ?`,
  [id]
);

// Normaliza la foto (añade prefijo data: o convierte Buffer -> base64)
const detalle = rowsDet.map(r => ({
  idProducto: r.idProducto,
  nombre:     r.nombre,
  cantidad:   Number(r.cantidad),
  precio:     Number(r.precio),
  foto:       normalizeFoto(r.foto)   // 👈 clave
}));

res.json({ ...venta, detalle });
  } catch (err) {
    console.error('GET /api/ventas/:id', err);
    res.status(500).json({ error: 'Error al consultar venta' });
  }
});

app.post('/api/ventas', async (req, res) => {
  const {
    idCliente, idUsuario,
    tipoComp, numeroDoc, ruc, razonSocial,
    metodoPago, numTarjeta, montoEfectivo, montoDevolucion,
    total, detalle
  } = req.body;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [v] = await conn.query(
      `INSERT INTO ventas
        (idCliente,idUsuario,tipoComp,numeroDoc,ruc,razonSocial,
         metodoPago,numTarjeta,montoEfectivo,montoDevolucion,total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [idCliente,idUsuario,tipoComp,numeroDoc,ruc,razonSocial,
       metodoPago,numTarjeta,montoEfectivo,montoDevolucion,total]
    );
    const idVenta = v.insertId;

    const vals = detalle.map(d => [idVenta, d.idProducto, d.cantidad, d.precio]);
    await conn.query(
      `INSERT INTO detalle_ventas (idVenta,idProducto,cantidad,precio) VALUES ?`,
      [vals]
    );

    for (const d of detalle) {
      await conn.query(`UPDATE productos SET cantidad = cantidad - ? WHERE id = ?`,
        [d.cantidad, d.idProducto]);
    }

    await conn.commit();
    res.status(201).json({ id: idVenta });
  } catch (err) {
    await conn.rollback();
    console.error('POST /api/ventas', err);
    res.status(500).json({ error: 'Error al crear venta' });
  } finally {
    conn.release();
  }
});

app.delete('/api/ventas/:id', async (req, res) => {
  const id = +req.params.id;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM detalle_ventas WHERE idVenta = ?`, [id]);
    const [r] = await conn.query(`DELETE FROM ventas WHERE id = ?`, [id]);
    if (!r.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ error: 'Venta no encontrada' });
    }
    await conn.commit();
    res.json({ message: 'Venta eliminada' });
  } catch (err) {
    await conn.rollback();
    console.error('DELETE /api/ventas/:id', err);
    res.status(500).json({ error: 'Error al eliminar venta' });
  } finally {
    conn.release();
  }
});
// 📊 Dashboard (KPIs + series + tops)
// GET /api/dashboard?days=30
app.get('/api/dashboard', async (req, res) => {
  try {
    const daysReq = parseInt(req.query.days, 10);
    const days = Number.isFinite(daysReq) ? Math.min(Math.max(daysReq, 1), 365) : 30;

    // Fecha desde (00:00:00)
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (days - 1));
    const sinceStr = `${toYMD(since)} 00:00:00`;

    // ===== KPIs =====
    const [[k1]] = await pool.query(
      `SELECT 
         COALESCE(SUM(v.total),0) AS ingresos,
         COUNT(*)                 AS ventas
       FROM ventas v
       WHERE v.fecha >= ?`,
      [sinceStr]
    );

    const [[k2]] = await pool.query(
      `SELECT 
         COUNT(DISTINCT v.idCliente)      AS clientes,
         COALESCE(SUM(dv.cantidad), 0)    AS items
       FROM ventas v
       LEFT JOIN detalle_ventas dv ON dv.idVenta = v.id
       WHERE v.fecha >= ?`,
      [sinceStr]
    );

    const kpis = {
      ingresos: Number(k1.ingresos || 0),
      ventas:   Number(k1.ventas   || 0),
      clientes: Number(k2.clientes || 0),
      items:    Number(k2.items    || 0),
    };

    // ===== Serie de ingresos por día =====
    const [rowsSerie] = await pool.query(
      `SELECT DATE(v.fecha) AS dia, COALESCE(SUM(v.total),0) AS ingresos
       FROM ventas v
       WHERE v.fecha >= ?
       GROUP BY DATE(v.fecha)
       ORDER BY dia ASC`,
      [sinceStr]
    );

    // Completar días faltantes con 0 para el gráfico
    const serieMap = new Map(rowsSerie.map(r => [toYMD(new Date(r.dia)), Number(r.ingresos || 0)]));
    const serieIngresos = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 86400000);
      const key = toYMD(d);
      serieIngresos.push({ fecha: key, ingresos: serieMap.get(key) || 0 });
    }

    // ===== Top clientes (gasto) =====
    const [topClientes] = await pool.query(
      `SELECT 
         c.id,
         c.nombres,
         COUNT(v.id)                 AS compras,
         COALESCE(SUM(v.total), 0)   AS gasto
       FROM ventas v
       JOIN clientes c ON c.id = v.idCliente
       WHERE v.fecha >= ?
       GROUP BY c.id, c.nombres
       ORDER BY gasto DESC
       LIMIT 8`,
      [sinceStr]
    );

    // ===== Top productos (unidades) =====
    const [topProductos] = await pool.query(
      `SELECT 
         p.id,
         p.nombre,
         COALESCE(SUM(dv.cantidad), 0) AS unidades
       FROM detalle_ventas dv
       JOIN ventas v    ON v.id = dv.idVenta
       JOIN productos p ON p.id = dv.idProducto
       WHERE v.fecha >= ?
       GROUP BY p.id, p.nombre
       ORDER BY unidades DESC
       LIMIT 8`,
      [sinceStr]
    );

    res.json({
      kpis,
      serieIngresos,             // [{fecha:'YYYY-MM-DD', ingresos:Number}, ...]
      topClientes: topClientes.map(r => ({
        id: r.id, nombres: r.nombres,
        compras: Number(r.compras || 0),
        gasto: Number(r.gasto || 0)
      })),
      topProductos: topProductos.map(r => ({
        id: r.id, nombre: r.nombre,
        unidades: Number(r.unidades || 0)
      }))
    });

  } catch (err) {
    console.error('GET /api/dashboard', err);
    res.status(500).json({ error: 'Error al generar dashboard' });
  }
});

/// 📦 Estáticos: HTML sin cache, assets con cache fuerte
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      // js/css/img: cache 1 año + immutable
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));
;

// ⚠️ Catch-all que NO atrape /api/*
app.get(/^\/(?!api\/|favicons\/).*/, (req, res) => sendHtml(res, 'index.html'));



// Arranque del servidor
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Puerto ${PORT} en uso, intentando en ${PORT + 1}...`);
    app.listen(PORT + 1, () => 
      console.log(`🚀 Ahora en http://localhost:${PORT + 1}`)
    );
  } else {
    console.error(err);
    process.exit(1);
  }
});
