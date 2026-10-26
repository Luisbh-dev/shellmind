import type en from '../en/identities';

const es: typeof en = {
    title: 'Identidades',
    description: 'Credenciales que comparten varios servidores: un usuario con contraseña, clave o el agente SSH. Cámbialas aquí una sola vez en lugar de en cada servidor.',
    generate: 'Generar clave',
    new: 'Nueva identidad',
    loading: 'Cargando identidades…',
    loadFailed: 'No se pudieron cargar las identidades.',
    retry: 'Reintentar',
    listLabel: 'Identidades guardadas',
    saved: '«{name}» guardada',
    created: '«{name}» creada',
    empty: {
        title: 'Aún no hay identidades',
        description: 'Crea una para las credenciales que usas en varios servidores, o genera una clave ed25519 nueva e instálala en ellos.'
    },
    credentials: {
        password: 'Contraseña',
        key: 'Clave',
        keyOfType: 'Clave ({type})',
        keyFile: 'Archivo de clave',
        agent: 'Agente SSH',
        none: 'Sin credenciales'
    },
    secrets: {
        password: 'contraseña',
        passphrase: 'frase de paso'
    },
    card: {
        user: 'Usuario',
        noUser: 'Los servidores conservan su propio usuario',
        unused: 'Aún sin usar',
        usedBy: {
            one: 'La usa 1 servidor',
            other: 'La usan {count} servidores'
        },
        keyFile: 'Lee',
        showKey: 'Mostrar la clave pública',
        hideKey: 'Ocultar la clave pública'
    },
    actions: {
        install: 'Instalar clave',
        installLabel: 'Instalar clave: {name}',
        edit: 'Editar',
        editLabel: 'Editar {name}',
        more: 'Más acciones de {name}',
        assign: 'Usar en servidores…',
        rotate: 'Rotar clave…',
        delete: 'Eliminar'
    },
    delete: {
        title: 'Eliminar identidad',
        message: '¿Eliminar «{name}» con su contraseña y clave guardadas? No se puede deshacer.',
        confirm: 'Eliminar',
        done: '«{name}» eliminada',
        inUse: 'Estos servidores aún usan «{name}». Asígnales otra identidad primero:',
        failed: 'No se pudo eliminar la identidad'
    },
    errors: {
        backend: 'No se pudo contactar con el backend de ShellMind. ¿Está en marcha?'
    },
    publicKey: {
        copied: 'Clave pública copiada',
        copyFailed: 'No se pudo copiar la clave pública',
        copyLabel: 'Copiar la clave pública de {name}'
    },
    picker: {
        noServers: 'Todavía no hay servidores SSH.',
        search: 'Buscar servidores',
        group: 'Grupo',
        allGroups: 'Todos los grupos',
        noGroup: 'Sin grupo',
        tag: 'Etiqueta',
        allTags: 'Todas las etiquetas',
        selected: '{count} de {total} seleccionados',
        selectShown: 'Seleccionar los visibles ({count})',
        clear: 'Quitar selección',
        noMatches: 'Ningún servidor coincide.',
        usesIdentity: 'Usa {name}'
    },
    install: {
        title: 'Instalar la clave de {name}',
        description: 'Añade la clave pública al authorized_keys del usuario de cada servidor, entrando con las credenciales actuales del servidor, y después comprueba que la clave sola permite entrar.',
        serversLabel: 'Servidores en los que instalar la clave',
        progressLabel: 'Progreso por servidor',
        start: {
            one: 'Instalar en 1 servidor',
            other: 'Instalar en {count} servidores'
        },
        stop: 'Detener',
        close: 'Listo',
        useIdentity: {
            one: 'Usar {name} en ese servidor',
            other: 'Usar {name} en esos {count} servidores'
        },
        useIdentityHint: 'La clave ya permite entrar en servidores que aún no usan «{name}». Pásalos a ella para dejar de depender de su propia contraseña.',
        phase: {
            waiting: 'En espera',
            installing: 'Añadiendo la clave…',
            verifying: 'Comprobando el acceso…'
        },
        outcome: {
            installed: 'Instalada · permite entrar',
            present: 'Ya estaba · permite entrar',
            unverified: 'Añadida, pero la clave sola no permite entrar',
            failed: 'Error',
            cancelled: 'Cancelado'
        },
        notAccepted: 'sshd no ha aceptado la clave por sí sola: revisa AuthorizedKeysFile y StrictModes en su sshd_config, y los permisos de la carpeta personal.',
        warnings: {
            homeWritable: 'Otros usuarios pueden escribir en la carpeta personal: sshd (StrictModes) ignora las claves hasta que se corrija (chmod go-w ~).',
            other: 'El servidor informó de un problema con sus archivos SSH.'
        },
        summary: {
            installed: '{count} instaladas',
            present: '{count} ya estaban',
            unverified: '{count} sin acceso',
            failed: '{count} con error',
            cancelled: '{count} canceladas',
            nothing: 'No se ha hecho nada.',
            running: '{done} de {total} terminados'
        }
    },
    rotate: {
        title: 'Rotar la clave de {name}',
        description: 'Sustituye la clave guardada por una clave ed25519 nueva sin dejar a nadie fuera.',
        steps: {
            one: 'Se genera una clave nueva y se instala en el servidor que usa esta identidad, entrando con la clave actual. Solo cuando la clave nueva permite entrar se sustituye la guardada.',
            other: 'Se genera una clave nueva y se instala en los {count} servidores que usan esta identidad, entrando con la clave actual. Solo cuando la clave nueva permite entrar en todos ellos se sustituye la guardada.'
        },
        noServers: 'Ningún servidor usa esta identidad: la clave se sustituye directamente.',
        oldKeyNote: 'La clave anterior se queda en su authorized_keys (puede que otras personas o herramientas dependan de ella); quítala de allí cuando ya no haga falta.',
        removeOld: 'Quitar la clave anterior de estos servidores',
        removeOldHint: 'Cuando todos los servidores entren con la clave nueva, la anterior se quita de su authorized_keys, para que una copia suya (una clave filtrada, un portátil perdido) deje de servir. Desmárcalo si otras personas o herramientas todavía entran con ella.',
        removal: {
            removed: 'Clave anterior quitada',
            absent: 'La clave anterior no estaba',
            failed: 'No se pudo quitar la clave anterior: todavía sirve para entrar aquí.',
            keptOne: 'La clave anterior sigue en el authorized_keys de 1 servidor: quítala allí a mano.',
            keptOther: 'La clave anterior sigue en el authorized_keys de {count} servidores: quítala allí a mano.'
        },
        passphrase: 'Frase de paso de la clave nueva',
        passphraseHint: 'Opcional. Déjala vacía para conservar la actual.',
        keepPassphrase: 'Déjala vacía para conservar la frase de paso actual',
        noPassphrase: 'Guardar la clave nueva sin frase de paso',
        noPassphraseHint: 'Se sigue guardando cifrada con la clave de datos de ShellMind.',
        force: 'Sustituir la clave aunque fallen algunos servidores',
        forceHint: 'Esos servidores necesitarán otra credencial (una contraseña) para entrar.',
        start: 'Rotar clave',
        replaced: 'Clave rotada. Nueva huella:',
        notReplaced: 'No se ha sustituido la clave: {count} servidor(es) no aceptaron la clave nueva. Corrígelos y vuelve a rotarla.',
        cancelled: 'Rotación cancelada: la clave no se ha sustituido.'
    },
    assign: {
        title: 'Usar {name} en servidores',
        description: 'Los servidores marcados entran con esta identidad; los desmarcados dejan de usarla y entran solo con sus propias credenciales.',
        serversLabel: 'Servidores que usan la identidad',
        clearOwn: 'Quitar la contraseña y la clave propias de los servidores que se añaden',
        clearOwnHint: {
            one: '1 de ellos tiene credenciales propias, que si no tendrían prioridad sobre las de la identidad.',
            other: '{count} de ellos tienen credenciales propias, que si no tendrían prioridad sobre las de la identidad.'
        },
        clearOwnHintNone: 'Las credenciales guardadas en un servidor tienen prioridad sobre las de la identidad.',
        windowsNote: 'Esta identidad no tiene contraseña: los servidores Windows se quedarían sin ella para Escritorio remoto.',
        uncheckedNote: 'ShellMind no ha comprobado que «{name}» permita entrar en {servers}. Si no lo permite, no podrán entrar cuando se quiten sus credenciales propias.',
        leftWithout: {
            one: '{servers} no tiene contraseña ni clave propias: cuando deje de usar esta identidad no podrá entrar hasta que lo edites o le asignes otra identidad.',
            other: '{servers} no tienen contraseña ni clave propias: cuando dejen de usar esta identidad no podrán entrar hasta que los edites o les asignes otra identidad.'
        },
        confirm: {
            title: '¿Quitar sus credenciales propias?',
            message: 'Se borrarán la contraseña y la clave guardadas de estos servidores. A partir de ahora entrarán solo con «{name}»:',
            unchecked: 'Sin comprobar: ShellMind no ha verificado que «{name}» permita entrar en {servers}.',
            confirm: 'Quitar y guardar'
        },
        willAdd: {
            one: '1 empezará a usarla',
            other: '{count} empezarán a usarla'
        },
        willRemove: {
            one: '1 dejará de usarla',
            other: '{count} dejarán de usarla'
        },
        save: 'Guardar',
        saved: 'Servidores de «{name}» actualizados'
    },
    import: {
        identities: 'Identidades',
        reviewTitle: 'Estas conexiones entrarían con credenciales guardadas en este equipo',
        reviewHint: 'El archivo nombra identidades guardadas aquí, o pide reenviar tu agente SSH, para hosts que él elige. Su contraseña o sus claves se ofrecerían a esos hosts.',
        toHost: 'se conecta a',
        savedIdentity: 'Identidad guardada «{identity}»',
        newIdentity: 'Identidad nueva «{identity}»',
        forwardsAgent: 'Reenvía tu agente SSH',
        consent: 'Confío en estos hosts: que usen estas credenciales',
        consentHint: 'Si no, se importan sin la identidad y sin reenvío del agente. Puedes asignarles una más tarde en Ajustes › Llavero.',
        linked: {
            one: '1 conexión entra con credenciales guardadas aquí:',
            other: '{count} conexiones entran con credenciales guardadas aquí:'
        },
        withheld: {
            one: '1 conexión se ha importado sin las credenciales guardadas que pedía (asígnale una identidad en Ajustes › Llavero si confías en ella):',
            other: '{count} conexiones se han importado sin las credenciales guardadas que pedían (asígnales una identidad en Ajustes › Llavero si confías en ellas):'
        }
    },
    sshImport: {
        agent: 'Agente SSH',
        hint: 'Los hosts que comparten un archivo de clave (IdentityFile) o el agente SSH (IdentityAgent) reciben una sola identidad en Ajustes › Llavero, para que esa clave se cambie en un único sitio.'
    },
    agent: {
        checking: 'Buscando un agente SSH…',
        unknown: 'No se pudo comprobar el agente SSH.',
        available: 'Agente SSH conectado',
        via: 'mediante {source}',
        keys: {
            one: '1 clave disponible',
            other: '{count} claves disponibles'
        },
        unreachable: 'No se puede contactar con el agente SSH ({source})',
        none: 'Sin agente SSH',
        sources: {
            env: 'SHELLMIND_SSH_AGENT',
            'ssh-auth-sock': 'SSH_AUTH_SOCK',
            'windows-openssh': 'Agente OpenSSH de Windows',
            pageant: 'Pageant'
        },
        fix: {
            env: 'Revisa la ruta de SHELLMIND_SSH_AGENT.',
            'ssh-auth-sock': '¿Sigue en marcha el agente?',
            'windows-openssh': 'Inicia el servicio «OpenSSH Authentication Agent».',
            pageant: 'Inicia el servicio «OpenSSH Authentication Agent» o Pageant.'
        },
        reasons: {
            disabled: 'SHELLMIND_SSH_AGENT está desactivado (off).',
            'remote-backend': 'ShellMind se ejecuta en otra máquina: su agente no sería el tuyo. Define SHELLMIND_SSH_AGENT en esa máquina para usar su agente.',
            'not-found': 'SSH_AUTH_SOCK no está definido para ShellMind. Inicia ssh-agent (o el agente de tu gestor de contraseñas) antes que ShellMind.'
        },
        errors: {
            'not-running': 'Pageant no se está ejecutando.',
            timeout: 'El agente no ha respondido a tiempo.',
            unreachable: 'No responde nada en su socket o canalización.'
        },
        showKeys: 'Claves',
        refresh: 'Volver a comprobar el agente SSH'
    },
    editor: {
        newTitle: 'Nueva identidad',
        editTitle: 'Editar identidad',
        description: 'Los servidores que la usan toman de ella lo que no tienen definido.',
        name: 'Nombre',
        namePlaceholder: 'p. ej. despliegue',
        username: 'Usuario',
        usernameHint: 'Opcional. El usuario propio de un servidor tiene prioridad.',
        password: 'Contraseña',
        passwordHint: 'Opcional. También es la contraseña de Escritorio remoto de los servidores Windows que no tengan la suya.',
        passwordPlaceholder: 'Contraseña de este usuario',
        keepPlaceholder: 'Déjalo vacío para conservar la guardada',
        saved: 'Guardada',
        willRemove: 'Se eliminará al guardar',
        remove: 'Eliminar',
        removeLabel: 'Eliminar la {secret} guardada',
        keepLabel: 'Conservar la {secret} guardada',
        key: 'Clave privada',
        keyModes: {
            keep: 'Actual',
            none: 'Ninguna',
            generate: 'Generar',
            paste: 'Pegar',
            file: 'Archivo'
        },
        keyModeHints: {
            keep: 'Conservar la clave guardada',
            none: 'Sin clave privada',
            generate: 'Generar un par de claves ed25519 nuevo, guardado cifrado',
            paste: 'Pegar una clave privada (OpenSSH, PEM o PuTTY)',
            file: 'Leer la clave de un archivo del equipo donde se ejecuta ShellMind'
        },
        generateNote: 'Se genera un par de claves ed25519 nuevo y se guarda cifrado. Solo se muestra su clave pública, para instalarla en los servidores.',
        comment: 'Comentario de la clave',
        commentHint: 'Se muestra junto a la clave en authorized_keys.',
        privateKey: 'Clave privada (PEM / OpenSSH)',
        replaceKeyHint: 'Sustituye la clave guardada al momento: los servidores que solo aceptan la actual la rechazarán. Rota la clave para instalar antes la nueva.',
        keyPath: 'Archivo de clave privada',
        keyPathHint: 'Se lee en el equipo donde se ejecuta ShellMind cada vez que conecta. ~ es tu carpeta personal.',
        passphrase: 'Frase de paso de la clave',
        passphraseHint: 'Solo si la clave está cifrada.',
        passphraseGenerateHint: 'Opcional. Cifra la clave nueva.',
        passphrasePlaceholder: 'Sin frase de paso',
        keptPassphrase: 'Frase de paso guardada',
        keptPassphraseHint: 'La clave guardada conserva su frase de paso. Para usar otra, rota la clave o vuelve a pegarla con la frase de paso nueva.',
        useAgent: 'Entrar con el agente SSH',
        useAgentHint: 'Usa las claves de ssh-agent, Pageant o el agente OpenSSH de Windows del equipo donde se ejecuta ShellMind (se prueban después de la contraseña y la clave).',
        usedBy: {
            one: 'Al guardar cambia cómo entra 1 servidor. Las sesiones abiertas siguen; las conexiones nuevas usan los valores nuevos.',
            other: 'Al guardar cambia cómo entran {count} servidores. Las sesiones abiertas siguen; las conexiones nuevas usan los valores nuevos.'
        },
        create: 'Crear identidad',
        createAndGenerate: 'Crear y generar clave',
        save: 'Guardar cambios',
        discard: {
            title: '¿Descartar los cambios?',
            message: 'Los cambios de esta identidad no se han guardado.',
            confirm: 'Descartar',
            cancel: 'Seguir editando'
        },
        errors: {
            nameRequired: 'Escribe un nombre.',
            nameTaken: 'Ya hay otra identidad con este nombre.',
            keyRequired: 'Pega la clave privada.',
            keyInvalid: 'No se puede leer esta clave privada: revisa la clave y su frase de paso.',
            keyPathRequired: 'Escribe la ruta del archivo de clave.',
            keyOrFile: 'Usa una clave guardada o un archivo de clave, no ambos.'
        }
    }
};

export default es;
