// Italian message dictionary for the shared UI.
//
// Translation of `../i18n.ts`, key for key: every English key has exactly one Italian
// entry with identical `{placeholders}`. Missing keys fall back to English at
// lookup time, so this table must never drop a key when English grows.
// Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub Releases",
// "GPL", "PNG", "JPEG", "URL", "CLI", "FAQ") stay literal.
//
// Erasable-syntax-only TypeScript (plain object, no enums) so node can
// type-strip it directly in tests.

export const it = {
  "view.diagnostics.signedInNote":
    "Se questo sito richiede l'accesso, questi dettagli potrebbero contenere informazioni sensibili. Controllali prima di condividerli.",
  "view.diagnostics.save": "Salva il rapporto diagnostico",
  "view.diagnostics.copyFailed": "Copia non riuscita. Seleziona e copia i dettagli qui sotto.",
  "view.diagnostics.loadFailed":
    "Impossibile leggere il rapporto completo. I dettagli disponibili sono mostrati qui sotto.",
  "desktop.done.title": "Immagine salvata",
  "desktop.done.partial": "Immagine salvata con parti mancanti",
  "desktop.done.size": "{width} × {height} pixel",
  "desktop.done.saved": "Salvata nella cartella scelta.",
  "desktop.done.open": "Apri immagine",
  "desktop.done.reveal": "Mostra nella cartella",
  "desktop.done.openError":
    "Impossibile aprire l’immagine. Verifica che sia installato un visualizzatore predefinito.",
  "desktop.done.folderError":
    "Impossibile aprire la cartella. Verifica che sia installato un gestore di file.",
  "desktop.done.missingError": "L’immagine o la cartella non esiste più.",
  "view.partial.title": "L’immagine è incompleta",
  "view.partial.summary": "Sono stati recuperati {done} frammenti su {total}.",
  "view.partial.gaps":
    "L’immagine salvata avrà parti mancanti. Nessun file è stato ancora salvato.",
  "view.partial.refused":
    "Il sito ha rifiutato i frammenti rimanenti. L’immagine salvata avrà parti mancanti.",
  "view.partial.save": "Salva immagine incompleta",
  "view.partial.cancel": "Annulla",
  "view.partial.retry": "Riprova i frammenti non riusciti",
  "view.partial.accessDenied": "Il sito ha rifiutato l’accesso a questa immagine",
  "view.partial.empty": "Impossibile recuperare l’immagine",
  "view.partial.noneSaved":
    "Nessuna parte dell’immagine è stata recuperata. Nessun file è stato salvato.",
  "view.partial.checkSource":
    "Apri la pagina di origine e verifica che il suo visualizzatore funzioni.",
  "view.partial.openSource": "Apri pagina di origine",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Capito",
  "view.modal.closeDialog": "Chiudi la finestra",
  "view.modal.closeTitle": "Chiudi",
  // Desktop-app guidance modal.
  "view.desktop.title": "Applicazione desktop Dezoomify",
  "view.desktop.subtitle":
    "Applicazione nativa ad alte prestazioni per opere museali gigapixel e scansioni locali",
  "view.desktop.installer": "L’{installer} non firmato per {platform} è disponibile su",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.releasesNote":
    "Nessun aggiornamento automatico; controlla GitHub Releases manualmente.",
  "view.desktop.installerMsi": "installer .msi",
  "view.desktop.installerDmg": "installer .dmg Apple silicon",
  "view.desktop.installerDeb": "installer .deb",
  "view.desktop.installerGeneric": "installer",
  "view.desktop.platformGeneric": "la vostra piattaforma",
  "view.desktop.whyTitle": "Perché usare l’applicazione desktop?",
  "view.desktop.why1Title": "Gestisce opere molto grandi:",
  "view.desktop.why1Body":
    "Una scheda del browser può contenere solo una certa quantità di immagine. L’applicazione desktop compone l’immagine in memoria in base alla memoria disponibile e scrive il risultato sul disco.",
  "view.desktop.why2Title": "Salva l’immagine finita:",
  "view.desktop.why2Body":
    "Ogni attività viene salvata in un solo file di uscita sul tuo computer.",
  "view.desktop.why3Title": "Quando il sito non riesce a finire:",
  "view.desktop.why3Body":
    "Il sito interrompe l’attività con un errore e rimanda all’applicazione desktop per l’immagine a piena dimensione.",
  "view.desktop.howTitle": "Come usarla",
  "view.desktop.step1":
    "Scarica l’{installer} non firmato per {platform} dalla nostra pagina GitHub Releases, quindi installalo. Non sono disponibili aggiornamenti automatici.",
  "view.desktop.step2":
    "Avvia Dezoomify e incolla l’indirizzo della tua immagine zoomabile o del manifesto.",
  "view.desktop.step3":
    "Scegli la risoluzione desiderata e la cartella di destinazione per salvare l’immagine completa composta.",
  "view.desktop.cliTitle": "Serve automazione? Prova Dezoomify CLI",
  "view.desktop.cliDesc":
    "Il CLI offre salvataggi programmabili senza interfaccia, ideali per procedure automatiche e server senza schermo.",
  "view.desktop.cliLink": "Scarica il CLI da GitHub Releases",
  // Browser-extension guidance modal.
  "view.ext.title": "Estensione del browser Dezoomify",
  "view.ext.subtitle":
    "Rilevamento automatico dei visori per archivi digitali protetti e pagine complesse",
  "view.ext.availableOn": "Disponibile su",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxStore": "Firefox Browser Add-ons",
  "view.ext.whyTitle": "Perché usare l’estensione del browser?",
  "view.ext.why1Title": "Pagine con accesso:",
  "view.ext.why1Body":
    "Mentre guardi un’immagine zoomabile, ritrova da sola l’immagine dietro il visore, anche nelle pagine dove hai effettuato l’accesso, come portali di biblioteche, abbonamenti museali e archivi accademici.",
  "view.ext.why2Title": "Facile da usare:",
  "view.ext.why2Body":
    "Premi il pulsante Dezoomify nella barra del browser e scegli l’immagine da salvare, oppure invia l’attività all’applicazione desktop se l’immagine è molto grande.",
  "view.ext.why3Title": "Privata:",
  "view.ext.why3Body":
    "Osserva solo la pagina che le hai indicato, e solo dopo che hai premuto il pulsante. Non sorveglia la tua navigazione in sottofondo.",
  "view.ext.howTitle": "Come usarla in 3 passi",
  "view.ext.step1": "Installa l’estensione dal Chrome Web Store o da Firefox Browser Add-ons.",
  "view.ext.step2":
    "Vai alla pagina del museo o della biblioteca che mostra la tua opera, accedendo se serve.",
  "view.ext.step3":
    "Fai clic sull’icona Dezoomify nella barra del browser per rilevare ed estrarre in automatico l’immagine a piena risoluzione!",
  // Access request (browser-session file access), shared access-request.tsx.
  "view.access.title": "Consenti l’accesso per continuare",
  "view.access.usesOrigin": "Questa immagine usa file di {origin}.",
  "view.access.needAccess":
    "Dezoomify ha bisogno di accesso per leggere quei file e comporre la tua immagine in questo browser.",
  "view.access.requesting": "Richiesta di accesso in corso…",
  "view.access.allow": "Consenti l’accesso e continua",
  // Idle input section.
  "view.idle.clearTitle": "Cancella il testo",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Ricerca dell’immagine zoomabile…",
  "view.step.preflighting": "Controllo delle dimensioni…",
  "view.step.downloading": "Scaricamento dei frammenti…",
  "view.step.saving": "Composizione dell’immagine finale…",
  "view.step.contactingDetail": "Contatto dell’host dell’immagine…",
  // Live job section.
  "view.job.techDetails": "Dettagli tecnici e registri",
  "view.job.manyImages": "{count} immagini",
  "view.job.paused": "In pausa",
  "view.job.retryingTiles": "Nuovo tentativo per {count} frammenti…",
  "view.job.waiting": "In attesa di {host}…",
  "view.job.sourceLabel": "Sorgente",
  "view.job.pause": "Pausa",
  "view.job.resume": "Riprendi",
  "view.job.stopReturn": "Ferma e torna all’inizio",
  "view.job.progressValue": "{done} completati, {active} in corso, {remaining} rimanenti",
  // Display-only section.
  "view.display.title": "Anteprima mostrata, non ancora salvata",
  "view.display.waysTitle": "Modi per salvare quest’opera",
  "view.display.extTitle": "Guida all’estensione del browser",
  "view.display.extDesc":
    "Per pagine che richiedono accesso o cookie di sessione. Rileva in automatico i visori nelle pagine attive.",
  "view.display.deskTitle": "Guida all’applicazione desktop",
  "view.display.deskDescClean":
    "Per un salvataggio pulito a piena dimensione quando il browser può solo mostrare l’immagine.",
  "view.display.startOver": "Ricomincia",
  "view.resolution.notice":
    "A causa dei limiti del browser non si scarica alla risoluzione massima. Prova l’applicazione desktop per rimuovere i limiti del browser.",
  "view.resolution.sizes": "Salvataggio a {selected} pixel invece del massimo {maximum} pixel.",
  "view.resolution.download": "Scarica l’applicazione desktop",
  "view.resolution.tryMaximum": "Prova il massimo",
  "view.resolution.stop": "Ferma",
  // Completion section.
  "view.done.ready": "La tua immagine è pronta.",
  "view.done.readyTitle": "Pronta da salvare",
  "view.done.saveNow": "Salva ora l’immagine",
  "view.done.another": "Dezoomifica un’altra immagine",
  // Failure section.
  "view.fail.title": "Impossibile dezoomificare l’immagine",
  "view.fail.deskDescLimits":
    "Per immagini oltre i limiti di memoria del browser, in base alla memoria disponibile. Elaborate in nativo sul tuo computer.",
  "view.fail.helpTitle": "Aiuto ed estrazione dell’indirizzo",
  "view.fail.helpDesc":
    "Come trovare l’indirizzo dell’immagine nei siti di musei e archivi, e cosa provare quando non si trova nulla.",
  "view.fail.reportBug": "Segnala un problema su GitHub",
  "view.fail.retry": "Riprova",
  "view.fail.canvasAllocation":
    "Questa immagine è troppo grande per essere assemblata in questa scheda del browser. L’applicazione desktop può salvarla a dimensione piena.",
  "view.fail.canvasContext":
    "Questa scheda del browser non ha potuto creare la superficie dell’immagine a questa dimensione. L’applicazione desktop può salvarla a dimensione piena.",
  // Cancelled section.
  "view.cancel.title": "Salvataggio annullato",
  "view.cancel.message": "Il salvataggio dell’immagine è stato interrotto.",
  // Job section and share chrome.
  "view.job.countsFull": "{current} frammenti su {total}",
  "view.job.countsActive": "{current} frammenti su {total} · {active} in corso",
  // Recent pictures, including unsuccessful attempts.
  "view.history.title": "Immagini recenti",
  "view.history.empty": "Ancora nessuna immagine recente. Le immagini avviate appaiono qui.",
  "view.history.localOnly": "Conservate solo su questo dispositivo.",
  "view.history.clear": "Cancella la cronologia",
  "view.history.image": "Immagine",
  "view.history.time": "Avvio",
  "view.history.size": "Dimensioni (px)",
  "view.history.status": "Stato",
  "view.history.remove": "Rimuovi",
  "view.history.removeImage": "Rimuovi {image} dalle immagini recenti",
  "view.history.status.started": "Avviata",
  "view.history.status.completed": "Completata",
  "view.history.status.partial": "Con lacune",
  "view.history.status.preview": "Solo anteprima",
  "view.history.status.failed": "Non riuscita",
  "view.history.status.cancelled": "Annullata",
  "view.history.status.deleted": "Eliminato",
  "view.history.status.checking": "Verifica del file…",
  "view.history.status.unavailable": "File non disponibile",
  "view.history.status.opening": "Apertura…",
  "view.history.openImage": "Apri {image}",
  "view.history.openFailed": "Impossibile aprire il file.",
  "view.input.description":
    "Dezoomify scarica immagini zoomabili in frammenti da biblioteche, musei, gallerie e altri siti web. Incolla qui sotto l’indirizzo di un’immagine per scaricarla.",
  "view.input.placeholder": "Incolla l’indirizzo di un visualizzatore o manifesto",
  "view.input.aria": "Indirizzo della pagina con l’immagine ingrandibile",
  "view.input.start": "Trova immagine",
  // Rate-limit explainers (see failure.ts plainMessageFor).
  "view.fail.rateProxy":
    "Il sito che ospita questa immagine limita quante pagine il nostro server può chiedergli, e quel limite è stato appena raggiunto, quindi la pagina non si è potuta aprire. L’estensione del browser e l’applicazione desktop scaricano dalla tua connessione invece che dal nostro server, quindi non sono toccate da questo limite.",
  "view.fail.rateDirect":
    "Il sito che ospita questa immagine sta ricevendo troppe richieste dalla tua connessione in questo momento. Attendere qualche minuto di solito risolve, e l’estensione o l’applicazione desktop vedranno lo stesso segnale occupato fino ad allora.",
  // Fetch-failure family (see failure.ts plainMessageFor).
  "view.fail.httpNotFound": "Questa pagina non è stata trovata. Controlla l’indirizzo e riprova.",
  "view.fail.httpRefused":
    "Il sito ha rifiutato di condividere questo file (HTTP {http}). Potrebbe bloccare i server condivisi; l’estensione del browser o l’app desktop potrebbero comunque funzionare.",
  "view.fail.httpSiteProblem":
    "Il sito ha avuto un problema nell’aprire questa pagina. Riprova a breve.",
  "view.fail.httpNotOpened": "Questa pagina non è stata aperta. Controlla l’indirizzo e riprova.",
  "view.fail.policyBlocked":
    "Questo indirizzo non può essere aperto tramite il sito. {hint} L’estensione del browser o l’app desktop potrebbero comunque funzionare.",
  "view.fail.hintAddress": "Controlla l’indirizzo e riprova.",
  "view.fail.hintPrivate": "Il sito non può aprire indirizzi privati o locali.",
  "view.fail.hintContentType":
    "Il sito ha risposto con un tipo di file che il sito non controlla qui.",
  "view.fail.hintRedirect": "Il sito ha reindirizzato in un modo che il sito non può seguire.",
  "view.fail.proxyBudget":
    "Questa pagina è troppo grande da controllare qui. Prova l’app desktop per le immagini molto grandi.",
  "view.fail.proxyFetch":
    "Il proxy dei metadati non ha potuto recuperare questo indirizzo. Riprova a breve.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid": "Inserisci un indirizzo web valido che inizi con http:// o https://",
  "desktop.settings.unusable":
    "Queste impostazioni di scaricamento non si possono usare. Regola le impostazioni evidenziate e riprova.",
  "desktop.settings.invalidSubmit":
    "Queste impostazioni di scaricamento non sono valide. Regolale e riprova.",
  "desktop.output.deniedPick":
    "La destinazione di salvataggio non è stata accettata. Scegli un altro file per continuare.",
  "desktop.output.exists":
    "Esiste già un file nella destinazione di salvataggio da {host}. Scegli un altro file o conferma la sovrascrittura per continuare.",
  "desktop.output.destDenied":
    "La destinazione di salvataggio non è stata accettata da {host}. Scegli un altro file per continuare.",
  "desktop.job.gone":
    "Questa attività non è più attiva da {host}. Ricomincia con un indirizzo nuovo.",
  "desktop.msg.thisPicture": "questa immagine",
  "desktop.msg.dimsPixels": "{a} per {b} pixel",
  "desktop.msg.needAbout": " Serve circa {need} di memoria",
  "desktop.output.canvasLimit":
    "Questa immagine è troppo grande per essere composta su questo computer ({dims},{need} a 4 byte per pixel, limite {limit}). Salva una versione più piccola con Larghezza max (CLI: --max-width). Nota: il JPEG accetta al più {jpegMax} pixel per lato; usa il PNG per immagini più grandi. Da {host}.",
  "desktop.output.jpegLimit":
    "Questa immagine ({dims}) è troppo grande per il JPEG, che accetta al più {jpegMax} pixel per lato. Salvala invece come PNG. Da {host}.",
  "desktop.output.webpLimit":
    "Questa immagine ({dims}) è troppo grande per il WebP, che accetta al più {webpMax} pixel per lato. Salvala invece come PNG. Da {host}.",
  "desktop.tile.partialDiscarded":
    "L’immagine parziale è stata scartata, nessun file conservato. Riprova da {host} con una connessione stabile.",
  "desktop.tile.partialChoice":
    "Alcune parti di questa immagine da {host} non si sono potute salvare. Riprova le parti mancanti, oppure conserva l’immagine parziale con aree vuote.",
  "view.discovery.none":
    "Nessuna immagine zoomabile trovata a questo indirizzo. Prova una pagina con un visualizzatore o l’estensione del browser.",
  "desktop.plan.none":
    "Questa immagine non ha dimensioni utili da salvare da {host}. Prova un’altra immagine o una Larghezza max minore.",
  "desktop.transport.stalled":
    "Salvataggio fermo durante il contatto con {host}. Controlla la connessione e riprova.",
  "desktop.output.writeFail":
    "Impossibile scrivere questa immagine da {host}. Scegli un’altra destinazione e riprova.",
  "desktop.job.cancelledMsg":
    "Il salvataggio dell’immagine è stato interrotto. Ogni file incompleto è stato rimosso.",
  "desktop.start.failed":
    "Impossibile avviare il salvataggio di questa immagine da {host}. Riprova.",
  "desktop.choice.failed": "Questa scelta non è stata accettata. Riprova.",
  "desktop.internal.error":
    "Un problema imprevisto ha interrotto questo salvataggio da {host}. Riprova e copia la diagnostica se ricapita.",
  "desktop.save.fallback": "Impossibile salvare questa immagine da {host}. Riprova.",
  "desktop.invoke.startFallback": "Impossibile avviare l’attività.",
  "desktop.invoke.partial": "La scelta di immagine parziale è stata rifiutata.",
  "desktop.rec.missing": "Frammenti mancanti: {shown}{rest}.",
  "desktop.rec.more": " e altri {n}",
  "desktop.rec.keep": "Conserva l’immagine parziale",
  "desktop.rec.discard": "Scarta la parziale",
  "desktop.rec.retryTiles": "Riprova i frammenti mancanti",
  "desktop.rec.missingSome": "Alcuni frammenti non si sono potuti salvare.",
  "desktop.rec.missingCount": "Impossibile salvare {count} frammenti.",
  "desktop.rec.missingOne": "Impossibile salvare {count} frammento.",
  "desktop.rec.missingList": "{n} frammenti mancanti: {shown}{rest}.",
  "desktop.rec.missingOneList": "{n} frammento mancante: {shown}{rest}.",
  "desktop.done.partialTitle": "Immagine parziale salvata",
  "desktop.done.partialDesc":
    "Questo file è marcato come parziale: {summary} Le aree mancanti restano vuote. Questo lo distingue da un salvataggio completo.",
  "desktop.cancel.note": "Salvataggio annullato. Pulizia fatta e ogni file incompleto rimosso.",
  "desktop.copy.diagnostics": "Copia la diagnostica",
  "desktop.copy.copied": "Copiata!",
  "desktop.panel.jobActions": "Azioni dell’attività desktop",
  "desktop.settings.reset": "Reimposta le impostazioni",
  "desktop.quick.info": "Altre informazioni",
  "desktop.quick.folderInfo": "Scegli dove salvare le immagini scaricate.",
  "desktop.quick.formatInfo":
    "Scegli un formato. Auto salva JPEG fino a 65.535 pixel per lato, altrimenti PNG.",
  "desktop.quick.sizeInfo":
    "Le impostazioni predefinite limitano larghezza e altezza mantenendo le proporzioni, senza ingrandimento; il livello sorgente può essere più piccolo. MB stimati = larghezza × altezza × byte/pixel / 1.000.000. PNG: 1,6 byte/pixel; WebP senza perdita: 1,3; TIFF/ZIF: 3. JPEG è calibrato con l’encoder nativo su due dipinti e una mappa: qualità ≤25: 0,1; ≤50: 0,15; ≤75: 0,2; ≤90: 0,3; ≤95: 0,4; ≤98: 0,45; ≤100: 0,5 byte/pixel. Auto stima JPEG perché queste dimensioni rispettano i suoi limiti. ZIF/IIIF aggiungono un terzo per la piramide. Ogni stima aggiunge un margine del 10 %, poi viene arrotondata per eccesso a multipli di 5 MB. Sono euristiche, non limiti garantiti; dettaglio, compressione sorgente, proporzioni, metadati e impostazioni dell’encoder influenzano la dimensione reale. Dimensioni intere/personalizzate richiedono le dimensioni sorgente.",
  "desktop.quick.maxWidth": "Larghezza max.",
  "desktop.quick.maxHeight": "Altezza max.",
  "desktop.quick.original": "Originale",
  "desktop.quick.userDefined": "Personalizzata",
  "desktop.quick.estimatedSize": "Dimensione stimata ({format})",
  "desktop.quick.networkInfo":
    "Veloce usa fino a 16 richieste simultanee senza attesa. Bilanciato avvia fino a 5 richieste al secondo; Delicato fino a 2. Un ritmo ridotto può aiutare i server occupati.",
  "desktop.quick.source": "Dipende dalla fonte",
  "desktop.quick.exact": "Personalizzato",
  "desktop.quick.upTo": "Fino a {size}K",
  "desktop.quick.hint.auto": "adattivo",
  "desktop.quick.hint.png": "senza perdita",
  "desktop.quick.hint.jpeg": "compresso",
  "desktop.quick.hint.tiff": "archivio",
  "desktop.quick.hint.webp": "senza perdita",
  "desktop.quick.hint.zif": "ingrandibile",
  "desktop.quick.hint.iiifDir": "a tasselli",
  "desktop.quick.format.auto":
    "JPEG fino a 65.535 pixel per lato, poi PNG. La qualità JPEG si applica anche ad Auto.",
  "desktop.quick.format.png":
    "Pixel senza perdita e trasparenza; file più grandi, adatti alla modifica.",
  "desktop.quick.format.jpeg":
    "File più piccoli con perdita. Nessuna trasparenza; massimo 65.535 pixel per lato. Regola la qualità nelle impostazioni.",
  "desktop.quick.format.tiff": "Formato senza perdita per archiviazione e modifica.",
  "desktop.quick.format.webp": "Formato compresso senza perdita, massimo 16.383 pixel per lato.",
  "desktop.quick.format.zif": "Piramide TIFF a tasselli senza perdita per diverse risoluzioni.",
  "desktop.quick.format.iiifDir":
    "Cartella con tasselli JPEG e info.json per ospitare un’immagine IIIF.",
  "desktop.quick.rate.maximum": "16 parallele",
  "desktop.quick.rate.balanced": "5/s",
  "desktop.quick.rate.gentle": "2/s",
  "desktop.quick.folder": "Cartella",
  "desktop.quick.askEachTime": "Chiedi ogni volta",
  "desktop.quick.chosenFolder": "Cartella scelta",
  "desktop.quick.chooseFolder": "Scegli la cartella iniziale per il salvataggio",
  "desktop.quick.format": "Formato",
  "desktop.quick.size": "Dimensione",
  "desktop.quick.network": "Rete",
  "desktop.quick.fast": "Veloce",
  "desktop.quick.balanced": "Bilanciata",
  "desktop.quick.gentle": "Delicata",
  "desktop.quick.fullResolution": "Risoluzione completa",
  "desktop.quick.upTo4k": "Fino a 4K",
  "desktop.quick.upTo2k": "Fino a 2K",
  "desktop.quick.custom": "Personalizzata…",
  "desktop.quick.more": "Altre impostazioni",
  "desktop.advanced.title": "Impostazioni avanzate",
  "desktop.advanced.done": "Fine",
  "desktop.advanced.jpegQuality": "Qualità JPEG",
  "desktop.advanced.jpegQualityDesc": "Un valore maggiore conserva più dettagli dell’immagine.",
  "desktop.advanced.compressionEffort": "Impegno di compressione",
  "desktop.advanced.compressionEffortDesc":
    "La qualità resta senza perdita; valori maggiori richiedono più tempo.",
  "desktop.advanced.dimensions": "Dimensioni personalizzate",
  "desktop.advanced.dimensionsDesc":
    "Lascia vuoto un valore per mantenere le proporzioni originali.",
  "desktop.advanced.width": "Larghezza",
  "desktop.advanced.height": "Altezza",
  "desktop.advanced.retries": "Tentativi",
  "desktop.advanced.retriesDesc":
    "Riprova i frammenti non riusciti prima di conservare un risultato parziale.",
  "desktop.advanced.resumeCache": "Cache di ripresa",
  "desktop.advanced.resumeCacheDesc": "Riutilizza i frammenti dopo un salvataggio interrotto.",
  "desktop.advanced.choose": "Scegli…",
  "desktop.advanced.change": "Modifica…",
  "desktop.advanced.headers": "Intestazioni della richiesta",
  "desktop.advanced.headersDesc": "Per i visori protetti. Inviate solo all’origine dell’immagine.",
  // Extension job-tab user copy, rendered through the same `t(key, vars)`
  // shape; log and diagnostics lines stay literal English and never use these
  // keys. `test/ui-i18n.test.mjs` fails when the page renders a key outside
  // this table.
} as const;
