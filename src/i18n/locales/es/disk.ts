import type en from '../en/disk';

// W8-T4 kit de disco lleno.
const es: typeof en = {
    action: 'Uso del disco y limpieza…',
    title: 'Uso del disco',
    loadFailed: 'No se han podido leer los sistemas de archivos de {name}.',
    refreshFailed: 'No se han podido volver a leer los sistemas de archivos: las cifras mostradas son las de antes.',
    loading: 'Leyendo los sistemas de archivos…',
    mountPicker: 'Sistema de archivos',
    mountOption: '{mount} · {percent} ocupado',
    freed: 'Se han liberado {size} en {mount}.',
    errors: {
        DISK_UNKNOWN_MOUNT: 'No está en un sistema de archivos local de este servidor.',
        DISK_NOTHING_TO_CLEAN: 'Ahora mismo no hay nada que limpiar.'
    },
    entry: {
        explore: 'Explorar {mount}',
        freeUp: 'Liberar espacio',
        freeUpOn: 'Liberar espacio en {mount}'
    },
    ai: {
        ask: '¿Por qué está lleno este disco?',
        hint: 'Con la pregunta van el uso de los sistemas de archivos, las carpetas y los archivos más grandes, los archivos borrados que siguen abiertos y lo que liberarían las limpiezas.',
        prompt: '¿Por qué está tan lleno {mount} y qué puedo borrar o mover sin riesgo para liberar espacio?',
        attachment: 'Disco {mount}',
        sections: {
            'disk-dirs': 'Directorios más grandes',
            'disk-files': 'Archivos más grandes',
            'disk-deleted': 'Archivos borrados aún abiertos',
            'disk-consumers': 'Consumidores conocidos y limpiezas'
        }
    },
    access: {
        root: 'root',
        sudo: 'sudo -n',
        admin: 'Administrador',
        elevatedHint: 'Los análisis lo leen todo y las limpiezas pueden ejecutarse: los comandos se ejecutan como root (con la sesión de {user}).',
        limited: 'Limitado: {user}',
        limitedHint: 'Inicia sesión como root, o con un usuario que pueda usar sudo sin contraseña, para leer todas las carpetas y poder limpiar.',
        limitedHintWindows: 'Inicia sesión como administrador para leer todas las carpetas y poder limpiar.'
    },
    summary: {
        label: 'Uso de {mount}',
        used: '{used} de {total} ocupados',
        free: '{size} libres',
        freeShort: '{size} libres',
        refresh: 'Volver a leer los sistemas de archivos',
        meter: 'Espacio ocupado en {mount}',
        readOnly: 'solo lectura',
        inodes: 'Inodos',
        inodesMeter: 'Inodos ocupados en {mount}',
        inodesText: '{percent} ocupado, {free} libres',
        inodesFree: '{free} libres',
        noInodes: 'Este sistema de archivos no tiene una tabla fija de inodos.'
    },
    tabs: {
        label: 'Vistas del disco',
        usage: 'Uso',
        files: 'Archivos más grandes',
        deleted: 'Borrados pero abiertos',
        cleanup: 'Limpiar'
    },
    usage: {
        up: 'Subir un nivel',
        atTop: 'Esta es la raíz del sistema de archivos.',
        breadcrumb: 'Carpeta',
        scanned: 'Analizado {ago}',
        scannedCached: 'Analizado {ago} (guardado)',
        cachedHint: 'Un análisis que ShellMind guarda unos minutos. Vuelve a analizar para medir de nuevo.',
        rescan: 'Volver a analizar',
        failed: 'No se ha podido analizar {path}.',
        scanning: 'Midiendo {path} (se detiene como mucho a los {seconds} s)…',
        empty: 'Esta carpeta está vacía.',
        columns: {
            name: 'Nombre',
            size: 'Tamaño',
            share: 'Proporción'
        },
        listLabel: 'Contenido de {path}, de mayor a menor',
        omitted: 'Y {count} elementos más pequeños ({size}).',
        count: '{count} elementos',
        countOne: '1 elemento',
        total: 'Total {size}',
        totalPartial: 'Al menos {size} (el análisis no terminó)',
        timedOut: 'El análisis se detuvo a los {seconds} s: los tamaños mostrados están completos, el resto no se ha medido. Abre una carpeta para acotarlo.',
        longer: 'Analizar hasta {minutes} min',
        denied: 'No se han podido leer {count} carpetas, así que estos tamaños se quedan cortos.',
        deniedOne: 'No se ha podido leer 1 carpeta, así que estos tamaños se quedan cortos.',
        notMeasured: 'sin medir',
        otherFs: 'otro sistema de archivos',
        notFollowed: 'enlace, no se sigue',
        partial: 'contado en parte',
        open: '{item} (abrir)',
        openMount: 'Explorar el sistema de archivos montado en {mount}',
        gap: 'Los archivos de aquí suman {found}, pero el sistema de archivos indica {used} ocupados: {gap} no están en ningún archivo visible. Lo habitual es que los retengan archivos borrados que algún proceso mantiene abiertos, o que queden ocultos bajo un punto de montaje.',
        gapWindows: 'Las carpetas de aquí suman {found}, pero la unidad indica {used} ocupados: {gap} no se han contado. Lo habitual es que sean archivos del sistema que el análisis no puede leer (instantáneas en System Volume Information, los archivos de paginación e hibernación).',
        gapAction: 'Ver archivos borrados'
    },
    files: {
        threshold: 'De más de',
        searched: 'Buscado {ago}',
        searchedCached: 'Buscado {ago} (guardado)',
        rescan: 'Volver a buscar',
        failed: 'No se han podido buscar los archivos grandes.',
        searching: 'Buscando en {mount} archivos de más de {size} (hasta 90 s)…',
        timedOut: 'La búsqueda se detuvo al llegar a su límite de tiempo: puede haber más archivos grandes.',
        none: 'No hay ningún archivo de más de {size} en {mount}.',
        caption: 'Archivos de más de {size} en {mount}, de mayor a menor',
        columns: {
            size: 'Tamaño',
            file: 'Archivo',
            modified: 'Modificado',
            owner: 'Propietario',
            actions: 'Acciones'
        },
        reveal: 'Mostrar la carpeta de {path} en Uso'
    },
    deleted: {
        intro: 'Los archivos borrados mientras un programa aún los tiene abiertos siguen ocupando espacio hasta que el programa los cierra. Lo habitual son logs rotados o eliminados con el servicio en marcha.',
        check: 'Volver a comprobar',
        limited: 'Solo se han podido comprobar los procesos del usuario de la sesión.',
        loadFailed: 'No se han podido comprobar los archivos borrados que siguen abiertos.',
        checking: 'Comprobando los archivos abiertos en {mount}…',
        none: 'Ningún archivo borrado está ocupando espacio en {mount}.',
        noneOwn: 'Ningún proceso de {user} mantiene abierto un archivo borrado en {mount}.',
        noneOwnDetail: 'No se han podido revisar los procesos de otros usuarios.',
        source: {
            lsof: 'Encontrados con lsof +L1.',
            proc: 'Encontrados en /proc (lsof no está instalado).'
        },
        summary: 'ocupados por {count} archivos borrados que siguen abiertos en {mount}',
        summaryOne: 'ocupados por 1 archivo borrado que sigue abierto en {mount}',
        caption: 'Archivos borrados que siguen abiertos en {mount}',
        columns: {
            size: 'Tamaño',
            file: 'Archivo',
            process: 'Proceso',
            runsIn: 'Se ejecuta en',
            actions: 'Acciones'
        },
        deletedTag: '(borrado)',
        pid: 'pid {pid} · fd {fd}',
        noOwner: 'sin servicio',
        needsRoot: 'requiere root',
        busy: 'hay otra acción en curso',
        actionsFor: 'Liberar el espacio de {path}',
        actions: {
            restartService: 'Reiniciar {unit}',
            restartContainer: 'Reiniciar el contenedor {container}',
            truncate: 'Vaciar el archivo ya (truncar)',
            terminate: 'Detener {process} (SIGTERM)'
        },
        confirm: {
            'restart-service': {
                title: '¿Reiniciar {unit}?',
                message: '{unit} se detiene y vuelve a arrancar: dejará de estar disponible un momento. En cuanto cierre {path}, se recuperan sus {size}.',
                confirm: 'Reiniciar {unit}'
            },
            'restart-container': {
                title: '¿Reiniciar el contenedor {container}?',
                message: 'El contenedor se detiene y vuelve a arrancar, y {process} con él. En cuanto se cierre {path}, se recuperan sus {size}.',
                confirm: 'Reiniciar el contenedor'
            },
            truncate: {
                title: '¿Vaciar {path}?',
                message: 'Se pierde el contenido del archivo borrado y sus {size} se recuperan ya. {process} (pid {pid}) sigue en marcha y puede seguir escribiendo en él.',
                confirm: 'Vaciar el archivo'
            },
            terminate: {
                title: '¿Detener {process}?',
                message: '{process} (pid {pid}) recibe SIGTERM y debería detenerse. Nada lo vuelve a arrancar salvo que lo haga un gestor de servicios. Sus {size} se recuperan cuando termine.',
                confirm: 'Detener el proceso'
            }
        },
        done: {
            'restart-service': '{unit} reiniciado.',
            'restart-container': 'Contenedor {container} reiniciado.',
            truncate: 'Se ha vaciado el archivo borrado de {process}.',
            terminate: 'Se ha pedido a {process} que se detenga.'
        },
        failed: 'No se ha podido liberar el espacio de ese archivo.'
    },
    cleanup: {
        intro: 'Midiendo lo que liberarían las limpiezas conocidas…',
        summary: 'Se podrían liberar unos {size} en {mount}.',
        summaryLocked: 'Las limpiezas necesitan root o sudo sin contraseña: los tamaños mostrados son lo que liberarían.',
        summaryLockedWindows: 'Las limpiezas necesitan un administrador: los tamaños mostrados son lo que liberarían.',
        summaryNone: 'Ahora mismo ninguna de las limpiezas conocidas liberaría espacio en {mount}: mira Uso y Archivos más grandes para ver qué lo llena.',
        measure: 'Volver a medir',
        measuring: 'Midiendo el journal, las cachés, los logs antiguos y los archivos temporales…',
        loadFailed: 'No se han podido medir las limpiezas.',
        noneKnown: 'Ninguna limpieza conocida se aplica a este servidor.',
        listLabel: 'Limpiezas',
        nothing: 'Nada que limpiar',
        needsAnalysis: 'Necesita un análisis',
        unavailable: 'No disponible',
        count: '{count} elementos',
        countOne: '1 elemento',
        estimateShort: {
            exact: 'según la herramienta',
            about: 'medido ahora',
            'up-to': 'como mucho',
            'at-least': 'como mínimo'
        },
        estimate: {
            exact: '{size} liberados',
            about: 'unos {size}',
            'up-to': 'hasta {size}',
            'at-least': 'al menos {size}',
            unknown: 'tamaño desconocido'
        },
        frees: 'Libera espacio en {mounts}',
        freesElsewhere: 'En {mounts} (otro sistema de archivos)',
        review: 'Revisar…',
        analyze: 'Analizar…',
        reason: {
            NOT_ELEVATED: 'Necesita root o sudo sin contraseña.',
            NOT_ELEVATED_WINDOWS: 'Necesita un administrador.',
            NOT_FOUND: 'No está en este servidor.',
            NO_ENGINE: 'El motor de contenedores no ha respondido.'
        },
        params: {
            keep: 'conservar {size}',
            keepBoth: 'conservar {size} y {days} días',
            older: 'de más de {days} días',
            olderOne: 'de más de 1 día',
            allAges: 'de cualquier antigüedad',
            noAgeLimit: 'sin límite de antigüedad',
            days: '{days} días',
            daysOne: '1 día'
        },
        paramLabels: {
            days: 'Solo archivos de más de',
            keepMB: 'Conservar como mucho',
            keepDays: 'Y nada de más de'
        },
        checking: 'Comprobando qué se eliminaría…',
        analyzing: 'Analizando el almacén de componentes: DISM puede tardar varios minutos (más de diez en algunos servidores)…',
        nothingNow: 'Con estos ajustes no hay nada que eliminar.',
        removes: 'Elimina {count} elementos',
        removesOne: 'Elimina 1 elemento',
        on: 'en {mounts}',
        journalUsage: 'El journal ocupa ahora {size}.',
        dismRecommended: 'DISM recomienda limpiar el almacén de componentes.',
        dismNotRecommended: 'DISM no recomienda limpiar ahora.',
        removedByPath: 'El find de este servidor no tiene -delete: cada archivo se borra con rm por su ruta completa.',
        itemsLabel: 'Lo que se elimina, de mayor a menor',
        moreItems: 'Y {count} más.',
        command: 'Se ejecuta en el servidor',
        confirm: 'Limpiar',
        confirmSize: 'Limpiar · {size}',
        done: '{name}: hecho.',
        failed: '{name} ha fallado.',
        resultTitle: '{name}: hecho',
        close: 'Cerrar',
        freedLabel: 'liberados, medido en el servidor antes y después',
        freedUnknown: 'No se ha podido medir el espacio libre después.',
        reported: 'La herramienta indicó {size}',
        mountsCaption: 'Espacio libre antes y después',
        columns: {
            mount: 'Sistema de archivos',
            before: 'Antes',
            after: 'Después'
        },
        free: '{size} libres',
        output: 'Comando y salida',
        noOutput: '(sin salida)',
        items: {
            journal: {
                title: 'Journal de systemd',
                desc: 'Archivos ya cerrados del journal, empezando por los más antiguos (journalctl --vacuum).',
                explain: 'journalctl elimina los archivos ya cerrados del journal, empezando por los más antiguos, hasta que el journal quepa en el tamaño que conservas, y los que superen la antigüedad que conservas. El journal activo nunca se elimina.',
                note: 'Los logs que superen lo que conservas se pierden para siempre: exporta antes lo que aún necesites.'
            },
            'package-cache': {
                title: 'Caché de paquetes',
                desc: 'Paquetes descargados que guarda el gestor de paquetes (apt, dnf, yum, apk, zypper).',
                explain: 'El gestor de paquetes borra los paquetes que descargó en instalaciones y actualizaciones anteriores. El software instalado no se toca; una instalación posterior volverá a descargar lo que necesite.',
                note: 'Se puede hacer en cualquier momento; la próxima actualización volverá a descargar sus paquetes.'
            },
            'rotated-logs': {
                title: 'Logs rotados antiguos',
                desc: 'Logs comprimidos y numerados en /var/log (*.gz, *.1, *-AAAAMMDD).',
                explain: 'Borra los logs que logrotate (o un servicio) ya rotó, de más antigüedad de la que elijas. Los logs actuales y el journal se conservan.',
                note: 'Comprueba que ninguna política de auditoría o retención obligue a conservarlos.'
            },
            tmp: {
                title: 'Archivos temporales antiguos',
                desc: 'Archivos de /tmp y /var/tmp que nadie ha leído ni cambiado en días.',
                explain: 'Borra los archivos de /tmp y /var/tmp que no se han leído, escrito ni cambiado en los días que elijas. Se conservan las carpetas temporales privadas de los servicios (systemd-private-*) y los sockets de X11.',
                note: 'Un programa que tenga un archivo abierto ahí tanto tiempo lo perdería: elige una antigüedad suficiente.'
            },
            'core-dumps': {
                title: 'Volcados de memoria',
                desc: 'Volcados de programas que fallaron (systemd-coredump, apport, /var/crash).',
                explain: 'Borra los volcados de memoria que dejaron los programas que fallaron. Solo sirven para depurar el fallo.',
                note: 'Si aún tienes que analizar un volcado, cópialo antes a otro sitio.'
            },
            'docker-dangling': {
                title: 'Imágenes huérfanas',
                desc: 'Imágenes sin etiqueta en las que no se basa nada (docker image prune).',
                explain: 'El motor de contenedores elimina las imágenes sin etiqueta en las que no se basa ninguna otra: restos de reconstrucciones y descargas.',
                note: 'Las imágenes que usa un contenedor, en marcha o parado, se conservan.'
            },
            'docker-unused': {
                title: 'Imágenes sin usar',
                desc: 'Todas las imágenes que no usa ningún contenedor (docker image prune -a).',
                explain: 'El motor de contenedores elimina todas las imágenes que no usa ningún contenedor, con etiqueta o sin ella. La próxima vez que se use una habrá que descargarla de nuevo.',
                note: 'Los contenedores parados conservan sus imágenes: elimínalos antes para liberarlas.'
            },
            'docker-build-cache': {
                title: 'Caché de compilación',
                desc: 'Capas que guarda el constructor para acelerar las compilaciones (docker builder prune).',
                explain: 'Docker elimina la caché de compilación que no usa ninguna compilación ni imagen. La próxima compilación de una imagen puede tardar más.',
                note: 'Solo Docker tiene una caché de compilación que podar.'
            },
            'docker-containers': {
                title: 'Contenedores parados',
                desc: 'Contenedores que terminaron y sus capas de escritura (docker container prune).',
                explain: 'El motor de contenedores elimina todos los contenedores que no están en marcha, con su capa de escritura y sus logs. Los volúmenes se conservan.',
                note: 'Un contenedor parado que pensabas volver a arrancar desaparece; sus volúmenes se quedan.'
            },
            'win-temp': {
                title: 'Archivos temporales',
                desc: 'Tu carpeta %TEMP% y C:\\Windows\\Temp.',
                explain: 'Borra los archivos de la carpeta temporal del usuario de la sesión y de C:\\Windows\\Temp de más antigüedad de la que elijas. Los archivos en uso se saltan.',
                note: 'Los instaladores a veces guardan archivos ahí mientras se ejecutan: evita limpiar durante una instalación.'
            },
            'win-update-cache': {
                title: 'Caché de Windows Update',
                desc: 'Actualizaciones descargadas (C:\\Windows\\SoftwareDistribution\\Download).',
                explain: 'Detiene los servicios de Windows Update y BITS, borra los archivos de actualización descargados y vuelve a arrancar los servicios. Las actualizaciones instaladas no se ven afectadas.',
                note: 'Las descargas pendientes vuelven a empezar desde el principio.'
            },
            'win-recycle-bin': {
                title: 'Papeleras de reciclaje',
                desc: 'Archivos borrados que se guardan en la papelera de cada unidad.',
                explain: 'Vacía las papeleras de reciclaje de todas las unidades fijas, de todos los usuarios.',
                note: 'Los archivos de las papeleras no se pueden recuperar después.'
            },
            'win-component-store': {
                title: 'Almacén de componentes (WinSxS)',
                desc: 'Componentes de Windows reemplazados (DISM /StartComponentCleanup).',
                explain: 'Para esta vista previa, DISM analiza el almacén de componentes; después, la limpieza elimina los componentes que han reemplazado actualizaciones más recientes, sin volver a analizar. Puede tardar bastante (media hora o más en algunos servidores); mientras tanto, el servidor sigue disponible.',
                note: 'Las actualizaciones instaladas antes de la limpieza ya no se podrán desinstalar.'
            }
        }
    }
};

export default es;
