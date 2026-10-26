import type en from '../en/addServer';

const es: typeof en = {
    newTitle: 'Nueva conexión',
    editTitle: 'Editar conexión',
    newDescription: 'Configura cómo se conecta ShellMind a tu equipo',
    editDescription: 'Actualiza los datos de la conexión',
    add: 'Añadir conexión',
    saveChanges: 'Guardar cambios',
    added: 'Conexión añadida',
    updated: 'Conexión actualizada',
    typeLabel: 'Tipo',
    organization: 'Organización',
    types: {
        linux: { label: 'SSH / Linux', hint: 'Shells de Linux y Unix por SSH.' },
        windows: { label: 'Windows', hint: 'Windows por OpenSSH (terminal, archivos, estado) y RDP.' },
        ftp: { label: 'FTP', hint: 'Transferencia de archivos por FTP, con cifrado opcional (FTPS).' },
        s3: { label: 'S3', hint: 'Almacenamiento de objetos compatible con S3 (AWS, MinIO, R2…).' },
        local: { label: 'CLI local', hint: 'Herramientas de línea de comandos locales (Azure, AWS, kubectl…) en un terminal real.' }
    },
    namePlaceholder: {
        linux: 'p. ej. BD de producción',
        windows: 'p. ej. Controlador de dominio',
        ftp: 'p. ej. Subidas web',
        s3: 'p. ej. Bucket de copias',
        local: 'p. ej. Azure (trabajo)'
    },
    presets: {
        shell: { label: 'Shell del sistema', note: 'Shell local completa (PowerShell / bash).' },
        azure: { label: 'Azure CLI', note: 'Consola "az>" limitada (solo subcomandos de az). Necesita la CLI de Azure.' },
        aws: { label: 'AWS CLI', note: 'Consola "aws>" limitada (solo subcomandos de aws). Necesita la CLI de AWS.' },
        gcloud: { label: 'Google Cloud', note: 'Consola "gcloud>" limitada. Necesita la CLI de gcloud.' },
        kubectl: { label: 'Kubernetes', note: 'Consola "kubectl>" limitada. Necesita kubectl.' },
        docker: { label: 'Docker', note: 'Consola "docker>" limitada (solo subcomandos de docker). Necesita Docker.' },
        custom: { label: 'Comando personalizado', note: 'Shell completa que lanza un programa concreto (p. ej. "wsl -d Ubuntu").' }
    },
    fields: {
        name: 'Nombre visible',
        cliPreset: 'Tipo de CLI',
        command: 'Comando',
        initialCommand: 'Ejecutar al conectar',
        cwd: 'Directorio de trabajo',
        host: 'Host / IP',
        sshPort: 'Puerto SSH',
        rdpPort: 'Puerto RDP',
        ftpPort: 'Puerto FTP',
        openSshPort: 'Puerto OpenSSH',
        domain: 'Dominio',
        username: 'Usuario',
        auth: 'Autenticación',
        password: 'Contraseña',
        windowsPassword: 'Contraseña (RDP / SSH)',
        privateKey: 'Clave privada (PEM / OpenSSH)',
        keyPath: 'Archivo de clave privada',
        passphrase: 'Frase de paso de la clave',
        ftpSecure: 'Cifrar la conexión (FTPS)',
        jumpHost: 'Host de salto',
        provider: 'Proveedor',
        bucket: 'Bucket',
        region: 'Región',
        endpoint: 'URL del endpoint',
        accessKey: 'Clave de acceso',
        secretKey: 'Clave secreta',
        group: 'Grupo',
        color: 'Color',
        tags: 'Etiquetas',
        notes: 'Notas'
    },
    hints: {
        command: 'Programa que se lanza. Déjalo vacío para usar la shell del sistema.',
        initialCommand: 'Opcional. Se ejecuta automáticamente al abrir la sesión.',
        cwd: 'Tu carpeta personal si lo dejas vacío',
        domain: 'Opcional. Dominio de inicio de sesión de Windows para Escritorio remoto.',
        windowsSsh: 'El terminal, los archivos y el estado usan OpenSSH Server en Windows.',
        windowsPasswordWithKey: 'Se usa para Escritorio remoto; SSH inicia sesión con la clave.',
        keyPath: 'Se lee en el equipo donde se ejecuta ShellMind cada vez que conecta. ~ es tu carpeta personal.',
        passphrase: 'Solo si la clave está cifrada',
        passwordPlaceholder: 'Contraseña de este usuario',
        s3SecretPlaceholder: 'Secreto de la clave de acceso',
        ftpSecure: 'TLS explícito (AUTH TLS). Desactívalo solo para servidores sin TLS: la contraseña viajaría en claro.',
        jumpHost: 'Conectar a través de otro servidor SSH guardado (ProxyJump).',
        group: 'p. ej. Producción',
        tags: 'Pulsa Intro o coma para añadir una etiqueta.'
    },
    auth: {
        password: 'Contraseña',
        key: 'Clave privada',
        keyFile: 'Archivo de clave'
    },
    jump: {
        none: 'Ninguno (conexión directa)'
    },
    s3: {
        aws: 'AWS S3',
        other: 'Otro (MinIO, R2…)'
    },
    secrets: {
        password: 'contraseña',
        privateKey: 'clave privada',
        passphrase: 'frase de paso',
        s3_secret_key: 'clave secreta de S3',
        identity: 'credenciales de la identidad',
        saved: 'Guardada',
        willRemove: 'Se eliminará al guardar',
        remove: 'Eliminar',
        removeLabel: 'Eliminar la {secret} guardada',
        undoRemoveLabel: 'Conservar la {secret} guardada',
        keepPlaceholder: 'Déjalo vacío para conservar la guardada',
        clearNotice: 'Al guardar se borrará: {secrets}.'
    },
    retarget: {
        title: '¿Conservar las credenciales guardadas?',
        message: 'Este cambio hace que la conexión apunte a otro destino (o desactiva el cifrado). ¿Enviar al nuevo destino lo guardado ({secrets})?',
        keep: 'Conservar y guardar',
        cancel: 'Volver',
        declined: 'No se ha guardado. Vuelve a introducir las credenciales, o elimina las guardadas, para guardar este cambio.'
    },
    identity: {
        label: 'Credenciales',
        hint: 'Entrar con una identidad guardada (Ajustes › Llavero) o con las credenciales propias de este servidor.',
        own: 'Las de este servidor',
        ownHint: 'Contraseña o clave guardadas solo en este servidor',
        usernameFromIdentity: 'Opcional: si lo dejas vacío, «{username}» de la identidad.',
        usernameDefault: 'Opcional: root si lo dejas vacío.',
        signsInWith: 'Entra con «{name}»:',
        windowsRdp: 'La contraseña de la identidad también se usa para Escritorio remoto.',
        windowsNoRdp: 'Esta identidad no tiene contraseña, así que este servidor no tendrá ninguna guardada para Escritorio remoto.',
        keepOwn: 'Conservar también la contraseña o la clave propias de este servidor',
        keepOwnHint: 'Se prueban primero. Déjalo desmarcado para eliminarlas y usar solo la identidad.'
    },
    agentForward: {
        label: 'Reenviar el agente SSH a los terminales',
        hint: 'Permite que los programas de este servidor (git, ssh) usen las claves de tu agente mientras haya un terminal abierto, hasta que se cierre la conexión. Cualquiera con root en el servidor también podría usarlas: solo para servidores de confianza.',
        needsAgent: 'Solo funciona con una identidad que entre con el agente SSH.'
    },
    discard: {
        title: '¿Descartar los cambios?',
        message: 'Los cambios de esta conexión no se han guardado.',
        confirm: 'Descartar',
        cancel: 'Seguir editando'
    },
    errors: {
        unknownPreset: 'ShellMind no conoce este tipo de CLI (lo guardó una versión anterior). Elige uno de la lista.',
        nameRequired: 'Escribe un nombre.',
        hostRequired: 'Escribe el nombre de host o la dirección IP.',
        port: 'Usa un puerto entre 1 y 65535, o déjalo vacío para el predeterminado.',
        usernameRequired: 'Escribe el usuario.',
        keyRequired: 'Pega la clave privada.',
        keyPathRequired: 'Escribe la ruta del archivo de clave.',
        bucketRequired: 'Escribe el nombre del bucket.',
        endpointRequired: 'Escribe la URL del endpoint.',
        accessKeyRequired: 'Escribe la clave de acceso.',
        secretRequired: 'Escribe la clave secreta.',
        backend: 'No se pudo contactar con el backend de ShellMind. ¿Está en marcha?'
    }
};

export default es;
