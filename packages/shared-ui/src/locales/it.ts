// Italian message dictionary for the shared UI.
//
// Mirrors `../i18n.ts` key for key: every English key has exactly one Italian
// entry with identical `{placeholders}`. Missing keys fall back to English at
// lookup time, so this table must never drop a key when English grows.
// Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub Releases",
// "GPL", "PNG", "JPEG", "URL", "CLI", "FAQ") stay literal.
//
// Erasable-syntax-only TypeScript (plain object, no enums) so
// `scripts/sync-web-js.mjs` can mirror it to `locales/it.js` for browsers.

export const it = {
  "desktop.done.title": "Immagine salvata",
  "desktop.done.partial": "Immagine salvata con parti mancanti",
  "desktop.done.size": "{width} × {height} pixel",
  "desktop.done.saved": "Salvata nella cartella scelta.",
  "desktop.done.open": "Apri immagine",
  "desktop.done.reveal": "Mostra nella cartella",
  "desktop.done.openError": "Impossibile aprire l’immagine. Verifica che sia installato un visualizzatore predefinito.",
  "desktop.done.folderError": "Impossibile aprire la cartella. Verifica che sia installato un gestore di file.",
  "desktop.done.missingError": "L’immagine o la cartella non esiste più.",
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Capito",
  "view.modal.closeDialog": "Chiudi la finestra",
  "view.modal.closeTitle": "Chiudi",
  // Desktop-app guidance modal.
  "view.desktop.title": "Applicazione desktop Dezoomify",
  "view.desktop.subtitle":
    "Applicazione nativa ad alte prestazioni per opere museali gigapixel e scansioni locali",
  "view.desktop.noInstaller":
    "Nessun installatore per ora. Un futuro installatore per {platform} apparira su",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.whyTitle": "Perche usare l applicazione desktop?",
  "view.desktop.why1Title": "Gestisce opere molto grandi:",
  "view.desktop.why1Body":
    "Una scheda del browser puo contenere solo una certa quantita di immagine. L applicazione desktop compone l immagine in memoria in base alla memoria disponibile e scrive il risultato sul disco.",
  "view.desktop.why2Title": "Salva l immagine finita:",
  "view.desktop.why2Body": "Ogni attivita viene salvata in un solo file di uscita sul tuo computer. Puoi accodare piu attivita; vengono salvate una alla volta.",
  "view.desktop.why3Title": "Quando il sito non riesce a finire:",
  "view.desktop.why3Body":
    "Il sito interrompe l attivita con un errore e rimanda all applicazione desktop per l immagine a piena dimensione.",
  "view.desktop.howTitle": "Come usarla",
  "view.desktop.step1":
    "Nessun installatore per ora; un futuro installatore per {platform} apparira sulla nostra pagina GitHub Releases.",
  "view.desktop.step2": "Avvia Dezoomify e incolla l indirizzo della tua immagine zoomabile o del manifesto.",
  "view.desktop.step3":
    "Scegli la risoluzione desiderata e la cartella di destinazione per salvare l immagine completa composta.",
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
  "view.ext.firefoxVersion": "Versione Firefox",
  "view.ext.firefoxSoon": "In arrivo",
  "view.ext.whyTitle": "Perche usare l estensione del browser?",
  "view.ext.why1Title": "Pagine con accesso:",
  "view.ext.why1Body":
    "Mentre guardi un immagine zoomabile, ritrova da sola l immagine dietro il visore, anche nelle pagine dove hai effettuato l accesso, come portali di biblioteche, abbonamenti museali e archivi accademici.",
  "view.ext.why2Title": "Facile da usare:",
  "view.ext.why2Body":
    "Premi il pulsante Dezoomify nella barra del browser e scegli l immagine da salvare, oppure invia l attivita all applicazione desktop se l immagine e molto grande.",
  "view.ext.why3Title": "Privata:",
  "view.ext.why3Body":
    "Osserva solo la pagina che le hai indicato, e solo dopo che hai premuto il pulsante. Non sorveglia la tua navigazione in sottofondo.",
  "view.ext.howTitle": "Come usarla in 3 passi",
  "view.ext.step1":
    "Installa l estensione dal Chrome Web Store. La versione Firefox e in arrivo.",
  "view.ext.step2":
    "Vai alla pagina del museo o della biblioteca che mostra la tua opera, accedendo se serve.",
  "view.ext.step3":
    "Fai clic sull icona Dezoomify nella barra del browser per rilevare ed estrarre in automatico l immagine a piena risoluzione!",
  // Idle input section.
  "view.idle.intro": "permette di salvare",
  "view.idle.zoomable": "immagini zoomabili",
  "view.idle.zoomableTitle": "Immagini grandi in cui si puo navigare dentro una pagina web.",
  "view.idle.enterThe": "Inserisci l",
  "view.idle.urlAbbr": "URL",
  "view.idle.urlTitle": "Uniform Resource Locator, l indirizzo di una pagina web",
  "view.idle.body":
    "di una tale immagine nel campo qui sotto. L immagine sara salvata alla massima risoluzione. Potrai poi fare clic destro sull immagine e scegliere «Salva con nome» per conservarla come PNG sul tuo computer. Se non funziona, leggi la nostra",
  "view.idle.troubleLink": "guida alla risoluzione dei problemi",
  "view.idle.moreInfo": "Per maggiori informazioni, leggi la nostra",
  "view.idle.projectLink": "pagina del progetto",
  "view.idle.license1": "Questo script e pubblicato sotto",
  "view.idle.gplLink": "GPL",
  "view.idle.sourceLink": "Vedi il codice sorgente",
  "view.idle.termsLink": "Decliniamo ogni responsabilita per un uso illegale di questo software",
  "view.idle.urlPlaceholder": "URL della pagina con la tua immagine",
  "view.idle.urlAria": "URL della pagina con la tua immagine zoomabile",
  "view.idle.clearTitle": "Cancella il testo",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Ricerca dell immagine zoomabile…",
  "view.step.choosingImage": "Immagine trovata; scelta della migliore…",
  "view.step.choosingLevel": "Scelta della risoluzione piu alta…",
  "view.step.preflighting": "Controllo delle dimensioni…",
  "view.step.downloading": "Salvataggio dei riquadri…",
  "view.step.saving": "Composizione dell immagine finale…",
  "view.step.working": "Elaborazione…",
  // Live job section.
  "view.job.workingOn": "Elaborazione di",
  "view.job.cancel": "Annulla",
  "view.job.change": "Cambia",
  "view.job.techDetails": "Dettagli tecnici e registri",
  "view.job.oneImage": "1 immagine",
  "view.job.manyImages": "{count} immagini",
  "view.job.autoChoiceFull": "{noun} trovata, salvo la piu grande possibile ({width}×{height}, {tiles} riquadri).",
  "view.job.autoChoiceDims": "{noun} trovata, salvo la piu grande possibile ({width}×{height}).",
  "view.job.autoChoiceTiles": "{noun} trovata, salvo la piu grande possibile ({tiles} riquadri).",
  "view.job.autoChoiceBare": "{noun} trovata, salvo la piu grande possibile.",
  "view.job.stalled":
    "Ancora al lavoro, {host} tarda a rispondere. Puoi attendere, oppure annullare e riprovare piu tardi.",
  // Display-only section.
  "view.display.title": "Anteprima mostrata, non ancora salvata",
  "view.display.shownPlain": "Mostrata qui sotto senza salvare.",
  "view.display.shownPrefix": "Mostrata qui sotto senza salvare.",
  "view.display.openDesktop": "Apri nell applicazione desktop",
  // One-click desktop handoff (todo 5.5): the button names the origin and the
  // summary names scope/recipient/job memory-only, mirroring the extension
  // consent pattern (origins, cookie names, job). The desktop app confirms
  // again before any effect; declining there does nothing.
  "view.handoff.send": "Invia all applicazione desktop",
  "view.handoff.sendOrigin": "Invia all applicazione desktop ({origin})",
  "view.handoff.summary":
    "Invia {origin} all applicazione desktop. Nessun dato di accesso viaggia; una sola attivita, solo in memoria.",
  "view.handoff.localNote":
    "I file locali restano su questo computer. Apri l applicazione desktop e scegli li il file; nulla viene inviato.",
  "view.display.waysTitle": "Modi per salvare quest opera",
  "view.display.extTitle": "Guida all estensione del browser",
  "view.display.extDesc":
    "Per pagine che richiedono accesso o cookie di sessione. Rileva in automatico i visori nelle pagine attive.",
  "view.display.deskTitle": "Guida all applicazione desktop",
  "view.display.deskDescClean": "Per un salvataggio pulito a piena dimensione quando il browser puo solo mostrare l immagine.",
  "view.display.startOver": "Ricomincia",
  // Completion section.
  "view.done.ready": "La tua immagine e pronta.",
  "view.done.savedDisk": "Salvata sul disco",
  "view.done.readyTitle": "Pronta da salvare",
  "view.done.saveNow": "Salva ora l immagine",
  "view.done.another": "Dezoomifica un altra immagine",
  // Already-saved completion (ViewContext.savedOutput): the host wrote the
  // output before rendering (for example the extension blob-anchor save), so
  // completion reads as saved with the file name and offers no second-click
  // save button. Absent keeps the website ready plus save-now path.
  "view.done.savedFile": "Salvata",
  "view.done.gaps": "Salvata con lacune",
  "view.done.savedFull": "{name} salvata ({w}x{h}).",
  "view.done.savedPartial":
    "{name} salvata ({w}x{h}, {done} riquadri su {total}; {failed} riquadro(i) mancante(i)).",
  // Gap map behind a kept partial: the missing-tile ledger renders inline
  // with the completion summary, so a partial save never reads as silent
  // gaps. `shown` lists the first ledger ids, `rest` names the overflow.
  "view.done.gapMap": "Riquadri mancanti ({failed} su {total}): {shown}{rest}.",
  "view.done.gapMapMore": ", e altri {n}",
  // Failure section.
  "view.fail.fallback": "Dezoomify non ha potuto trovare o salvare l immagine zoomabile a questo indirizzo.",
  "view.fail.title": "Impossibile dezoomificare l immagine",
  "view.fail.deskDescLimits":
    "Per immagini oltre i limiti di memoria del browser, in base alla memoria disponibile. Elaborate in nativo sul tuo computer.",
  "view.fail.helpTitle": "Aiuto ed estrazione dell indirizzo",
  "view.fail.helpDesc":
    "Come trovare l indirizzo dell immagine nei siti di musei e archivi, e cosa provare quando non si trova nulla.",
  "view.fail.techDetails": "Dettagli tecnici dell errore e segnalazione",
  "view.fail.reportBug": "Segnala un problema su GitHub",
  "view.fail.retry": "Riprova",
  // Cancelled section.
  "view.cancel.title": "Salvataggio annullato",
  "view.cancel.message": "Il salvataggio dell immagine e stato interrotto.",
  // Generic fallback for unknown phases (debug surface; status codes stay raw).
  "view.generic.status": "Stato:",
  "view.generic.reset": "Reimposta",
  // Image and level picker dialogs.
  "view.pick.imageTitle": "Scegli un immagine",
  "view.pick.imageSub":
    "L immagine consigliata e gia selezionata. Premi Usa la selezione per continuare con un clic.",
  "view.pick.imageGroup": "Immagini trovate in questa pagina",
  "view.pick.autoImage": "Usa la piu grande possibile",
  "view.pick.autoImageMeta": "Consigliata, un clic",
  "view.pick.cancel": "Annulla",
  "view.pick.useSelected": "Usa la selezione",
  "view.pick.levelTitle": "Scegli una risoluzione",
  "view.pick.levelSub": "Adatta allo schermo e gia selezionata. Premi Usa la selezione per continuare con un clic.",
  "view.pick.levelGroup": "Risoluzioni per l immagine scelta",
  "view.pick.fitScreen": "Adatta allo schermo",
  "view.pick.fitScreenMeta": "Risoluzione piu alta possibile, consigliata",
  "view.pick.fullRes": "Piena risoluzione",
  "view.pick.fullResMeta": "La piu grande disponibile",
  "view.pick.levelName": "Livello {index}",
  "view.pick.loadingSize": "dimensione mostrata durante il caricamento",
  "view.pick.fits": "adatta al browser",
  "view.pick.tooLarge": "troppo grande, serve l applicazione desktop",
  "view.pick.tilesMeta": ", {tiles} riquadri",
  // Job section picker and share chrome.
  "view.job.shareTitle": "Copia l indirizzo della pagina per questa attivita, non il file immagine",
  "view.job.shareLink": "Copia il collegamento a questa attivita",
  "view.job.chooseImage": "{noun} trovata. Scegli quale immagine salvare{suffix}",
  "view.job.chooseLevel": "Immagine scelta. Scegli una risoluzione{suffix}",
  "view.job.chooseBtn": "Scegli",
  "view.job.chooseAria": "Scegli tra le opzioni proposte",
  "view.job.changeAria": "Sulla scelta automatica",
  "view.job.pickHint": "La scelta consigliata e gia selezionata. Premi Scegli per verificarla.",
  "view.job.autoHintChoose":
    "Il sito salva da solo l immagine piu grande. Per sceglierne un altra, usa Scegli durante la scelta, oppure l applicazione desktop.",
  "view.job.countsFull": "{current} riquadri su {total}",
  "view.job.countsElapsed": "{current} riquadri su {total} · {elapsed} trascorsi",
  "view.job.elapsedOnly": "{elapsed} trascorsi",
  // Recent-jobs history (todo 5.2): local-only ledger.
  "view.history.title": "Immagini recenti",
  "view.history.empty": "Ancora nessuna immagine recente. Le immagini salvate appaiono qui.",
  "view.history.localOnly": "Conservate solo su questo dispositivo.",
  "view.history.open": "Riapri",
  "view.history.clear": "Cancella la cronologia",
  "view.history.dims": "{w} per {h} pixel",
  "view.input.eyebrow": "Salvataggio di immagini zoomabili",
  "view.input.title": "Dezoomify",
  "view.input.description":
    "Dezoomify permette di salvare immagini zoomabili. Incolla qui sotto l URL di un visualizzatore, manifesto o indirizzo di tasselli. Dezoomify trova l immagine e salva la risoluzione piu alta adatta al browser. Quando e pronta, usa il pulsante Salva immagine per salvarla sul tuo computer.",
  "view.input.placeholder": "Incolla l indirizzo di un visualizzatore o manifesto",
  "view.input.aria": "Indirizzo della pagina con l immagine ingrandibile",
  "view.input.start": "Trova immagine",
  // Failure "What happened" explainer.
  "view.fail.whatHappened": "Cosa e successo",
  "view.fail.rateProxy":
    "Il sito che ospita questa immagine limita quante pagine il nostro server puo chiedergli, e quel limite e stato appena raggiunto, quindi la pagina non si e potuta aprire. L estensione del browser e l applicazione desktop scaricano dalla tua connessione invece che dal nostro server, quindi non sono toccate da questo limite.",
  "view.fail.rateDirect":
    "Il sito che ospita questa immagine sta ricevendo troppe richieste dalla tua connessione in questo momento. Attendere qualche minuto di solito risolve, e l estensione o l applicazione desktop vedranno lo stesso segnale occupato fino ad allora.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid": "Inserisci un indirizzo web valido che inizi con http:// o https://",
  "desktop.url.notWebPage":
    "Questo indirizzo non sembra una pagina web. Inserisci un indirizzo che inizi con http:// o https://.",
  "desktop.settings.unusable":
    "Queste impostazioni di scaricamento non si possono usare. Regola le impostazioni evidenziate e riprova.",
  "desktop.settings.invalidSubmit": "Queste impostazioni di scaricamento non sono valide. Regolale e riprova.",
  "desktop.output.deniedPick": "La destinazione di salvataggio non e stata accettata. Scegli un altro file per continuare.",
  "desktop.output.deniedFallback": "La destinazione di salvataggio e stata rifiutata.",
  "desktop.proto.incompatible":
    "Questa versione dell applicazione non puo aprire questa immagine da {host}. Aggiorna l applicazione e riprova.",
  "desktop.handoff.rejected":
    "Questo collegamento non si puo aprire da {host}. Prova un altro indirizzo senza dati di accesso.",
  "desktop.handoff.acceptedDetail":
    "Questa immagine si puo passare a un altra applicazione. Sei gia nell applicazione nativa, quindi puoi continuare qui.",
  "desktop.handoff.rejectedDetail":
    "Questa immagine non si puo passare a un altra applicazione. Continua qui o prova un altra immagine.",
  "desktop.output.exists":
    "Esiste gia un file nella destinazione di salvataggio da {host}. Scegli un altro file o conferma la sovrascrittura per continuare.",
  "desktop.output.destDenied":
    "La destinazione di salvataggio non e stata accettata da {host}. Scegli un altro file per continuare.",
  "desktop.job.gone": "Questa attivita non e piu attiva da {host}. Ricomincia con un indirizzo nuovo.",
  "desktop.msg.thisPicture": "questa immagine",
  "desktop.msg.dimsPixels": "{a} per {b} pixel",
  "desktop.msg.needAbout": " Serve circa {need} di memoria",
  "desktop.output.canvasLimit":
    "Questa immagine e troppo grande per essere composta su questo computer ({dims},{need} a 4 byte per pixel, limite {limit}). Salva una versione piu piccola con Larghezza max (CLI: --max-width). Nota: il JPEG accetta al piu {jpegMax} pixel per lato; usa il PNG per immagini piu grandi. Da {host}.",
  "desktop.output.jpegLimit":
    "Questa immagine ({dims}) e troppo grande per il JPEG, che accetta al piu {jpegMax} pixel per lato. Salvala invece come PNG. Da {host}.",
  "desktop.tile.partialDiscarded":
    "L immagine parziale e stata scartata, nessun file conservato. Riprova da {host} con una connessione stabile.",
  "desktop.tile.partialChoice":
    "Alcune parti di questa immagine da {host} non si sono potute salvare. Riprova le parti mancanti, oppure conserva l immagine parziale con aree vuote.",
  "desktop.discovery.none":
    "Nessuna immagine zoomabile trovata a questo indirizzo da {host}. Prova un altra pagina o controlla l indirizzo.",
  "desktop.plan.none":
    "Questa immagine non ha dimensioni utili da salvare da {host}. Prova un altra immagine o una Larghezza max minore.",
  "desktop.transport.stalled": "Salvataggio fermo durante il contatto con {host}. Controlla la connessione e riprova.",
  "desktop.output.writeFail":
    "Impossibile scrivere questa immagine da {host}. Scegli un altra destinazione e riprova.",
  "desktop.job.cancelledMsg": "Il salvataggio dell immagine e stato interrotto. Ogni file incompleto e stato rimosso.",
  "desktop.start.failed": "Impossibile avviare il salvataggio di questa immagine da {host}. Riprova.",
  "desktop.choice.failed": "Questa scelta non e stata accettata. Riprova.",
  "desktop.save.generic": "Impossibile salvare questa immagine da {host}. Riprova con un altro indirizzo.",
  "desktop.internal.error":
    "Un problema imprevisto ha interrotto questo salvataggio da {host}. Riprova e copia la diagnostica se ricapita.",
  "desktop.save.fallback": "Impossibile salvare questa immagine da {host}. Riprova.",
  "desktop.job.failedFallback": "L attivita non e riuscita.",
  "desktop.invoke.startFallback": "Impossibile avviare l attivita.",
  "desktop.invoke.choiceImage": "La scelta dell immagine e stata rifiutata.",
  "desktop.invoke.choiceLevel": "La scelta della risoluzione e stata rifiutata.",
  "desktop.invoke.retry": "La richiesta di nuovo tentativo e stata rifiutata.",
  "desktop.invoke.partial": "La scelta di immagine parziale e stata rifiutata.",
  "desktop.invoke.destination": "Impossibile richiedere la destinazione di salvataggio.",
  "desktop.step.chooseWhere": "Scegli dove salvare…",
  "desktop.step.chooseWhereDetail": "La destinazione di salvataggio richiede attenzione prima di continuare.",
  "desktop.step.pickOutput": "Scegli il file di uscita per continuare.",
  "desktop.step.partialTitle": "Alcuni riquadri non si sono potuti salvare…",
  "desktop.step.partialDetail": "Scegli se conservare l immagine parziale, scartarla o riprovare.",
  "desktop.step.displayPreview": "Solo anteprima…",
  "desktop.step.displayDetail": "Questa immagine si puo solo vedere qui.",
  "desktop.step.cleanupDetail": "Pulizia… rimozione del file incompleto…",
  "desktop.step.cleaningShort": "Pulizia…",
  "desktop.step.encodingNative": "Codifica nell applicazione nativa",
  "desktop.step.encodingPartial": "Codifica dell immagine parziale nell applicazione nativa",
  "desktop.step.discardingPartial": "Scarto dell immagine parziale",
  "desktop.step.retrying": "Nuovo tentativo",
  "desktop.step.appAutoDetail": "L applicazione salva da sola la prima immagine; nessun selettore offerto.",
  "desktop.step.foundFits": "{noun} trovata, salvo la piu grande possibile…",
  "desktop.step.tilesAtFull": "{current} riquadri su {total} a piena risoluzione",
  "desktop.step.savedDims": "{width} per {height} pixel salvati",
  "desktop.step.partialDims": "Immagine parziale {width} per {height} pixel; {summary}",
  "desktop.step.partialSaved": "Immagine parziale salvata; {summary}",
  "desktop.step.savedWord": "Salvata",
  "desktop.step.contacting": "Contatto {host}…",
  "desktop.link.title": "Un altra applicazione vuole aprire un immagine in Dezoomify.",
  "desktop.link.source": "Origine: {url}",
  "desktop.link.prov": "Provenienza: collegamento dezoomify:// (v{version})",
  "desktop.link.provHint": "Provenienza: collegamento dezoomify:// (v{version}) · {hint}",
  "desktop.link.note": "Nulla avviene finche non confermi. Rifiutare non fa nulla.",
  "desktop.link.dismiss": "Ignora",
  "desktop.link.open": "Apri l immagine",
  "desktop.rec.partialTitle": "Alcuni riquadri non si sono potuti salvare",
  "desktop.rec.partialDesc":
    "Manca parte dell immagine. {summary} Conserva l immagine parziale (le aree vuote restano vuote), scartala oppure riprova i riquadri mancanti.",
  "desktop.rec.missing": "Riquadri mancanti: {shown}{rest}.",
  "desktop.rec.more": " e altri {n}",
  "desktop.rec.destTitle": "La destinazione di salvataggio richiede attenzione",
  "desktop.rec.destDesc":
    "La destinazione di salvataggio non e stata accettata. Scegli un file di uscita, riprova oppure usa un altra applicazione.",
  "desktop.rec.chooseTitle": "Scegli dove salvare",
  "desktop.rec.chooseDesc": "Scegli il file di uscita per continuare a salvare questa immagine.",
  "desktop.rec.keep": "Conserva l immagine parziale",
  "desktop.rec.discard": "Scarta la parziale",
  "desktop.rec.retryTiles": "Riprova i riquadri mancanti",
  "desktop.rec.chooseOutput": "Scegli l uscita…",
  "desktop.rec.tryAgain": "Riprova",
  "desktop.rec.useOther": "Usa un altra applicazione",
  "desktop.rec.missingSome": "Alcuni riquadri non si sono potuti salvare.",
  "desktop.rec.missingCount": "{count} riquadro{plural} non si sono potuti salvare.",
  "desktop.rec.missingList": "{n} riquadro{plural} mancante(i): {shown}{rest}.",
  "desktop.done.partialTitle": "Immagine parziale salvata",
  "desktop.done.partialDesc":
    "Questo file e marcato come parziale: {summary} Le aree mancanti restano vuote. Questo lo distingue da un salvataggio completo.",
  "desktop.cancel.note": "Salvataggio annullato. Pulizia fatta e ogni file incompleto rimosso.",
  "desktop.copy.diagnostics": "Copia la diagnostica",
  "desktop.copy.copied": "Copiata!",
  // Multi-job queue panel (desktop integration queue, todo 5.3). Jobs save
  // one at a time in the order they were added; a failed job never stops the
  // rest. Only redacted origins appear here, never full addresses.
  "desktop.queue.title": "Coda",
  "desktop.queue.statusQueued": "In attesa",
  "desktop.queue.statusActive": "In corso",
  "desktop.queue.statusDone": "Fatta",
  "desktop.queue.statusFailed": "Non riuscita",
  "desktop.queue.statusCancelled": "Annullata",
  "desktop.queue.cancel": "Annulla",
  "desktop.queue.cancelAll": "Annulla tutto",
  "desktop.queue.retry": "Riprova",
  "desktop.queue.summary": "{succeeded} fatte, {failed} non riuscite, {total} totali",
  "desktop.queue.progress": "{current} riquadri su {total}",
  "desktop.queue.unknownOrigin": "il server",
  "desktop.panel.outputFormat": "Formato di uscita",
  "desktop.panel.jobActions": "Azioni dell attivita desktop",
  "desktop.help.title": "Aiuto e informazioni",
  "desktop.help.help": "Aiuto",
  "desktop.help.desktopGuide": "Guida desktop",
  "desktop.help.troubleshooting": "Risoluzione dei problemi",
  "desktop.help.faq": "FAQ",
  "desktop.help.privacy": "Privacy",
  "desktop.help.terms": "Termini",
  "desktop.help.donate": "Dona",
  "desktop.settings.title": "Personalizza",
  "desktop.settings.desc":
    "Impostazioni minime di scaricamento. Salvate su questo dispositivo e usate per la prossima attivita. Le intestazioni vanno solo all origine dell immagine e non sono mai registrate.",
  "desktop.settings.fileGroup": "File",
  "desktop.settings.imageGroup": "Immagine",
  "desktop.settings.networkGroup": "Rete e ripristino",
  "desktop.settings.outputDir": "Cartella di uscita (facoltativa)",
  "desktop.settings.compression": "Compressione 0-100 (predefinita 5)",
  "desktop.settings.maxWidth": "Larghezza max in px (facoltativa)",
  "desktop.settings.maxHeight": "Altezza max in px (facoltativa)",
  "desktop.settings.retries": "Tentativi 0-100 (predefiniti 3, 0 = nessuno)",
  "desktop.settings.cacheDir": "Cartella di cache (facoltativa, ripresa)",
  "desktop.settings.emptyLargest": "vuoto = la piu grande",
  "desktop.settings.browse": "Sfoglia…",
  "desktop.settings.browseOutput": "Scegli la cartella di uscita",
  "desktop.settings.browseCache": "Scegli la cartella di cache",
  "desktop.settings.headersAdv": "Avanzate: intestazioni di richiesta (fidate)",
  "desktop.settings.headersLabel": "Intestazioni di richiesta, una per riga come Nome: valore (facoltative, fidate)",
  "desktop.settings.reset": "Reimposta le impostazioni",
  "desktop.quick.folder": "Cartella",
  "desktop.quick.askEachTime": "Chiedi ogni volta",
  "desktop.quick.chosenFolder": "Cartella scelta",
  "desktop.quick.chooseFolder": "Scegli la cartella iniziale per il salvataggio",
  "desktop.quick.format": "Formato",
  "desktop.quick.size": "Dimensione",
  "desktop.quick.network": "Rete",
  "desktop.quick.fast": "Veloce",
  "desktop.quick.balanced": "Bilanciata · 5/s",
  "desktop.quick.gentle": "Delicata · 2/s",
  "desktop.quick.fullResolution": "Risoluzione completa",
  "desktop.quick.upTo4k": "Fino a 4K",
  "desktop.quick.upTo2k": "Fino a 2K",
  "desktop.quick.custom": "Personalizzata…",
  "desktop.quick.more": "Altre impostazioni",
  "desktop.advanced.title": "Impostazioni avanzate",
  "desktop.advanced.done": "Fine",
  "desktop.advanced.jpegQuality": "Qualita JPEG",
  "desktop.advanced.jpegQualityDesc": "Un valore maggiore conserva piu dettagli dell immagine.",
  "desktop.advanced.compressionEffort": "Impegno di compressione",
  "desktop.advanced.compressionEffortDesc": "La qualita resta senza perdita; valori maggiori richiedono piu tempo.",
  "desktop.advanced.dimensions": "Dimensioni personalizzate",
  "desktop.advanced.dimensionsDesc": "Lascia vuoto un valore per mantenere le proporzioni originali.",
  "desktop.advanced.width": "Larghezza",
  "desktop.advanced.height": "Altezza",
  "desktop.advanced.retries": "Tentativi",
  "desktop.advanced.retriesDesc": "Riprova le tessere non riuscite prima di conservare un risultato parziale.",
  "desktop.advanced.resumeCache": "Cache di ripresa",
  "desktop.advanced.resumeCacheDesc": "Riutilizza le tessere dopo un salvataggio interrotto.",
  "desktop.advanced.choose": "Scegli…",
  "desktop.advanced.change": "Modifica…",
  "desktop.advanced.headers": "Intestazioni della richiesta",
  "desktop.advanced.headersDesc": "Per i visori protetti. Inviate solo all origine dell immagine e mai registrate.",
  // Extension modal user copy. The modal
  // imports this table through its vendored `vendor/i18n.js` codegen
  // mirror (see `scripts/sync-web-js.mjs`) and renders through the same
  // `t(key, vars)` shape; log and diagnostics lines stay literal English and
  // never use these keys. `test/ui-i18n.test.mjs` fails when the page renders
  // a key outside this table.
  "page.step.scanning": "Scansione della pagina…",
  "page.step.finding": "Ricerca dell immagine zoomabile ({done}/{total})…",
  "page.step.choosing": "Scelta della risoluzione piu alta…",
  "page.step.saving": "Salvataggio dei riquadri…",
  "page.step.assembling": "Composizione dell immagine finale…",
  "page.step.done": "Fatta",
  "page.step.cancelled": "Annullata",
  "page.step.cancelling": "Annullamento…",
  "page.step.displaying": "Mostro l immagine…",
  "page.tabs.scan": "Scansiona {label}",
  "page.tabs.hint":
    "Apri una pagina con un immagine zoomabile, poi fai clic sul pulsante Dezoomify per scansionare quella scheda.",
  "page.handoff.sendOrigin": "Invia all applicazione desktop ({origin})",
  "page.handoff.stay": "Resta nell estensione",
  "page.handoff.send": "Invia all applicazione desktop",
  "page.handoff.title": "Inviare all applicazione desktop?",
  "page.handoff.host": "Host: {host}",
  "page.handoff.origins": "Origini: {list}",
  "page.handoff.originsNone": "Origini: (nessuna)",
  "page.handoff.cookies": "Cookie: {list}",
  "page.handoff.cookiesNone": "Cookie: (nessuno)",
  "page.handoff.job": "Attivita: {id}",
  "page.handoff.note": "Nulla viene inviato finche non confermi. Rifiutare tiene l attivita nell estensione.",
  "page.ui.techDetails": "Dettagli tecnici e registri",
} as const;
