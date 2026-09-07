// French message dictionary for the shared UI.
//
// Mirrors `../i18n.ts` key for key: every English key has exactly one French
// entry with identical `{placeholders}`. Missing keys fall back to English at
// lookup time, so this table must never drop a key when English grows.
// Brand and product names ("Dezoomify", "Chrome Web Store", "GitHub Releases",
// "GPL", "PNG", "JPEG", "URL", "CLI", "FAQ") stay literal.
//
// Erasable-syntax-only TypeScript (plain object, no enums) so
// `scripts/sync-web-js.mjs` can mirror it to `locales/fr.js` for browsers.

export const fr = {
  // Modal chrome (shared view.ts openModal).
  "view.modal.ok": "Compris",
  "view.modal.closeDialog": "Fermer la boite de dialogue",
  "view.modal.closeTitle": "Fermer",
  // Desktop-app guidance modal.
  "view.desktop.title": "Application de bureau Dezoomify",
  "view.desktop.subtitle":
    "Application native haute performance pour les oeuvres museales gigapixels et les numerisations locales",
  "view.desktop.noInstaller":
    "Aucun installateur pour le moment. Un futur installateur pour {platform} paraitra sur",
  "view.desktop.releasesLink": "GitHub Releases",
  "view.desktop.whyTitle": "Pourquoi utiliser l application de bureau ?",
  "view.desktop.why1Title": "Prend en charge les oeuvres tres grandes :",
  "view.desktop.why1Body":
    "Un onglet de navigateur ne peut contenir qu une certaine quantite d image. L application de bureau assemble l image en memoire (jusqu a sa limite de canevas de 8 Gio, avec la memoire libre correspondante) et ecrit le resultat sur le disque.",
  "view.desktop.why2Title": "Enregistre l image terminee :",
  "view.desktop.why2Body": "Chaque tache est enregistree dans un fichier de sortie sur votre ordinateur. Vous pouvez mettre plusieurs taches en file ; elles sont enregistrees une par une.",
  "view.desktop.why3Title": "Quand le site web ne peut pas terminer :",
  "view.desktop.why3Body":
    "Le site web interrompt la tache avec une erreur et renvoie vers l application de bureau pour l image en pleine taille.",
  "view.desktop.howTitle": "Comment l utiliser",
  "view.desktop.step1":
    "Aucun installateur pour le moment ; un futur installateur pour {platform} paraitra sur notre page GitHub Releases.",
  "view.desktop.step2": "Lancez Dezoomify et collez l adresse de votre image zoomable ou de votre manifeste.",
  "view.desktop.step3":
    "Choisissez la resolution souhaitee et le dossier de destination pour enregistrer l image complete assemblee.",
  "view.desktop.cliTitle": "Besoin d automatiser ? Essayez Dezoomify CLI",
  "view.desktop.cliDesc":
    "Le CLI offre un enregistrement scriptable sans interface, ideal pour les chaines automatisees et les serveurs sans ecran.",
  "view.desktop.cliLink": "Obtenir le CLI sur GitHub Releases",
  // Browser-extension guidance modal.
  "view.ext.title": "Extension de navigateur Dezoomify",
  "view.ext.subtitle":
    "Detection automatique des visionneuses pour les archives numeriques protegees et les pages complexes",
  "view.ext.availableOn": "Disponible sur",
  "view.ext.chromeStore": "Chrome Web Store",
  "view.ext.firefoxVersion": "Version Firefox",
  "view.ext.firefoxSoon": "En preparation",
  "view.ext.whyTitle": "Pourquoi utiliser l extension de navigateur ?",
  "view.ext.why1Title": "Pages avec connexion :",
  "view.ext.why1Body":
    "Pendant que vous regardez une image zoomable, elle retrouve automatiquement l image derriere la visionneuse, y compris sur les pages ou vous etes connecte, comme les portails de bibliotheques, les abonnements museaux et les archives universitaires.",
  "view.ext.why2Title": "Simple d utilisation :",
  "view.ext.why2Body":
    "Appuyez sur le bouton Dezoomify dans la barre d outils du navigateur et choisissez l image a enregistrer, ou envoyez la tache vers l application de bureau si l image est tres grande.",
  "view.ext.why3Title": "Respectueux de la vie privee :",
  "view.ext.why3Body":
    "Elle examine uniquement la page que vous lui avez indiquee, et seulement apres que vous avez appuye sur le bouton. Elle n observe pas votre navigation en arriere-plan.",
  "view.ext.howTitle": "Comment l utiliser en 3 etapes",
  "view.ext.step1":
    "Installez l extension depuis le Chrome Web Store. La version Firefox est en preparation.",
  "view.ext.step2":
    "Rendez-vous sur la page du musee ou de la bibliotheque qui montre votre oeuvre, en vous connectant si besoin.",
  "view.ext.step3":
    "Cliquez sur l icone Dezoomify dans la barre d outils de votre navigateur pour detecter et extraire automatiquement l image en pleine resolution !",
  // Idle input section.
  "view.idle.intro": "permet d enregistrer",
  "view.idle.zoomable": "des images zoomables",
  "view.idle.zoomableTitle": "De grandes images dans lesquelles on peut naviguer a l interieur d une page web.",
  "view.idle.enterThe": "Saisissez l",
  "view.idle.urlAbbr": "URL",
  "view.idle.urlTitle": "Uniform Resource Locator, l adresse d une page web",
  "view.idle.body":
    "d une telle image dans le champ ci-dessous. L image sera enregistree a la resolution maximale. Vous pourrez ensuite faire un clic droit sur l image et choisir « Enregistrer sous » pour la conserver en PNG sur votre ordinateur. En cas d echec, lisez notre",
  "view.idle.troubleLink": "guide de depannage",
  "view.idle.moreInfo": "Pour en savoir plus, lisez notre",
  "view.idle.projectLink": "page du projet",
  "view.idle.license1": "Ce script est publie sous",
  "view.idle.gplLink": "GPL",
  "view.idle.sourceLink": "Voir le code source",
  "view.idle.termsLink": "Nous declinons toute responsabilite en cas d usage illegal de ce logiciel",
  "view.idle.urlPlaceholder": "URL de la page contenant votre image",
  "view.idle.urlAria": "URL de la page contenant votre image zoomable",
  "view.idle.clearTitle": "Effacer la saisie",
  "view.idle.submit": "Dezoomify !",
  // Job step labels.
  "view.step.discovering": "Recherche de l image zoomable…",
  "view.step.choosingImage": "Image trouvee ; choix de la meilleure…",
  "view.step.choosingLevel": "Choix de la plus haute resolution…",
  "view.step.preflighting": "Verification de la taille de l image…",
  "view.step.downloading": "Enregistrement des tuiles…",
  "view.step.saving": "Assemblage de l image finale…",
  "view.step.working": "En cours…",
  // Live job section.
  "view.job.workingOn": "En cours sur",
  "view.job.cancel": "Annuler",
  "view.job.change": "Modifier",
  "view.job.techDetails": "Details techniques et journaux",
  "view.job.oneImage": "1 image",
  "view.job.manyImages": "{count} images",
  "view.job.autoChoiceFull": "{noun} trouvee, enregistrement de la plus grande possible ({width}×{height}, {tiles} tuiles).",
  "view.job.autoChoiceDims": "{noun} trouvee, enregistrement de la plus grande possible ({width}×{height}).",
  "view.job.autoChoiceTiles": "{noun} trouvee, enregistrement de la plus grande possible ({tiles} tuiles).",
  "view.job.autoChoiceBare": "{noun} trouvee, enregistrement de la plus grande possible.",
  "view.job.stalled":
    "Toujours en cours, {host} tarde a repondre. Vous pouvez attendre, ou annuler et reessayer plus tard.",
  // Display-only section.
  "view.display.title": "Apercu affiche, non enregistre",
  "view.display.shownPlain": "Affiche ci-dessous sans enregistrement.",
  "view.display.shownPrefix": "Affiche ci-dessous sans enregistrement.",
  "view.display.openDesktop": "Ouvrir dans l application de bureau",
  // One-click desktop handoff (todo 5.5): the button names the origin and the
  // summary names scope/recipient/job memory-only, mirroring the extension
  // consent pattern (origins, cookie names, job). The desktop app confirms
  // again before any effect; declining there does nothing.
  "view.handoff.send": "Envoyer vers l application de bureau",
  "view.handoff.sendOrigin": "Envoyer vers l application de bureau ({origin})",
  "view.handoff.summary":
    "Envoie {origin} vers l application de bureau. Aucune donnee de connexion ne voyage ; une seule tache, gardee en memoire.",
  "view.handoff.localNote":
    "Les fichiers locaux restent sur cet ordinateur. Ouvrez l application de bureau et choisissez-y le fichier ; rien n est envoye.",
  "view.display.waysTitle": "Moyens d enregistrer cette oeuvre",
  "view.display.extTitle": "Guide de l extension de navigateur",
  "view.display.extDesc":
    "Pour les pages demandant une connexion ou des cookies de session. Detecte automatiquement les visionneuses sur les pages actives.",
  "view.display.deskTitle": "Guide de l application de bureau",
  "view.display.deskDescClean": "Pour un enregistrement propre en pleine taille quand le navigateur peut seulement montrer l image.",
  "view.display.startOver": "Recommencer",
  // Completion section.
  "view.done.ready": "Votre image est prete.",
  "view.done.savedDisk": "Enregistre sur le disque",
  "view.done.readyTitle": "Pret a enregistrer",
  "view.done.saveNow": "Enregistrer l image maintenant",
  "view.done.another": "Dezoomifier une autre image",
  // Already-saved completion (ViewContext.savedOutput): the host wrote the
  // output before rendering (for example the extension blob-anchor save), so
  // completion reads as saved with the file name and offers no second-click
  // save button. Absent keeps the website ready plus save-now path.
  "view.done.savedFile": "Enregistre",
  "view.done.gaps": "Enregistre avec des manques",
  "view.done.savedFull": "{name} enregistre ({w}x{h}).",
  "view.done.savedPartial":
    "{name} enregistre ({w}x{h}, {done} tuiles sur {total} ; {failed} tuile(s) manquante(s)).",
  // Gap map behind a kept partial: the missing-tile ledger renders inline
  // with the completion summary, so a partial save never reads as silent
  // gaps. `shown` lists the first ledger ids, `rest` names the overflow.
  "view.done.gapMap": "Tuiles manquantes ({failed} sur {total}) : {shown}{rest}.",
  "view.done.gapMapMore": ", et {n} de plus",
  // Failure section.
  "view.fail.fallback": "Dezoomify n a pas pu trouver ni enregistrer l image zoomable a cette adresse.",
  "view.fail.title": "Impossible de dezoomifier l image",
  "view.fail.deskDescLimits":
    "Pour les images qui depassent les limites memoire du navigateur, dans la limite de canevas de 8 Gio (avec la memoire libre correspondante). Traitees en natif sur votre ordinateur.",
  "view.fail.helpTitle": "Aide et extraction d URL",
  "view.fail.helpDesc":
    "Comment trouver l adresse de l image sur les sites de musees et d archives, et quoi essayer quand rien n est trouve.",
  "view.fail.techDetails": "Details techniques de l erreur et rapport de bogue",
  "view.fail.reportBug": "Signaler un bogue sur GitHub",
  "view.fail.retry": "Reessayer",
  // Cancelled section.
  "view.cancel.title": "Enregistrement annule",
  "view.cancel.message": "L enregistrement de l image a ete interrompu.",
  // Generic fallback for unknown phases (debug surface; status codes stay raw).
  "view.generic.status": "Etat :",
  "view.generic.reset": "Reinitialiser",
  // Image and level picker dialogs.
  "view.pick.imageTitle": "Choisir une image",
  "view.pick.imageSub":
    "L image recommandee est deja selectionnee. Appuyez sur Utiliser la selection pour continuer en un clic.",
  "view.pick.imageGroup": "Images trouvees sur cette page",
  "view.pick.autoImage": "Utiliser la plus grande possible",
  "view.pick.autoImageMeta": "Recommande, en un clic",
  "view.pick.cancel": "Annuler",
  "view.pick.useSelected": "Utiliser la selection",
  "view.pick.levelTitle": "Choisir une resolution",
  "view.pick.levelSub": "Ajuste a l ecran est deja selectionne. Appuyez sur Utiliser la selection pour continuer en un clic.",
  "view.pick.levelGroup": "Resolutions pour l image choisie",
  "view.pick.fitScreen": "Ajuste a l ecran",
  "view.pick.fitScreenMeta": "Plus haute resolution qui convient, recommande",
  "view.pick.fullRes": "Pleine resolution",
  "view.pick.fullResMeta": "La plus grande disponible",
  "view.pick.levelName": "Niveau {index}",
  "view.pick.loadingSize": "taille affichee pendant le chargement",
  "view.pick.fits": "convient au navigateur",
  "view.pick.tooLarge": "trop grand, necessite l application de bureau",
  "view.pick.tilesMeta": ", {tiles} tuiles",
  // Job section picker and share chrome.
  "view.job.shareTitle": "Copie l adresse de la page pour cette tache, pas le fichier image lui-meme",
  "view.job.shareLink": "Copier le lien vers cette tache",
  "view.job.chooseImage": "{noun} trouvee. Choisissez l image a enregistrer{suffix}",
  "view.job.chooseLevel": "Image choisie. Choisissez une resolution{suffix}",
  "view.job.chooseBtn": "Choisir",
  "view.job.chooseAria": "Choisir parmi les options proposees",
  "view.job.changeAria": "A propos du choix automatique",
  "view.job.pickHint": "Le choix recommande est deja selectionne. Appuyez sur Choisir pour le verifier.",
  "view.job.autoHintChoose":
    "Le site web enregistre automatiquement la plus grande image. Pour choisir une autre image, utilisez Choisir pendant la selection, ou l application de bureau.",
  "view.job.countsFull": "{current} tuiles sur {total}",
  "view.job.countsElapsed": "{current} tuiles sur {total} · {elapsed} ecoulees",
  "view.job.elapsedOnly": "{elapsed} ecoulees",
  // Recent-jobs history (todo 5.2): local-only ledger with one-click reopen.
  "view.history.title": "Images recentes",
  "view.history.empty": "Aucune image recente pour le moment. Les images enregistrees apparaissent ici.",
  "view.history.localOnly": "Conserve uniquement sur cet appareil.",
  "view.history.open": "Rouvrir",
  "view.history.clear": "Effacer l historique",
  "view.history.optIn": "Conserver les adresses completes pour rouvrir en un clic (pages ordinaires seulement)",
  "view.history.sensitiveNote": "Adresse masquee pour confidentialite",
  "view.history.dims": "{w} par {h} pixels",
  // Failure "What happened" explainer.
  "view.fail.whatHappened": "Ce qui s est passe",
  "view.fail.rateProxy":
    "Le site qui heberge cette image limite le nombre de pages que notre serveur peut lui demander, et cette limite vient d etre atteinte, donc la page n a pas pu etre ouverte. L extension de navigateur et l application de bureau telechargent depuis votre propre connexion au lieu de notre serveur, elles ne sont donc pas concernees par cette limite.",
  "view.fail.rateDirect":
    "Le site qui heberge cette image recoit actuellement trop de demandes depuis votre propre connexion. Attendre quelques minutes suffit generalement, et l extension de navigateur ou l application de bureau verront le meme signal d encombrement jusque-la.",
  // Desktop app user copy (apps/desktop/src/main.tsx). Logs and technical
  // diagnostics stay literal English and never use these keys.
  "desktop.url.invalid": "Veuillez saisir une adresse web valide commencant par http:// ou https://",
  "desktop.url.notWebPage":
    "Cette adresse ne ressemble pas a une adresse de page web. Saisissez une adresse commencant par http:// ou https://.",
  "desktop.settings.unusable":
    "Ces parametres de telechargement ne peuvent pas etre utilises. Ajustez les parametres surlignes et reessayez.",
  "desktop.settings.invalidSubmit": "Ces parametres de telechargement sont invalides. Ajustez-les et reessayez.",
  "desktop.output.deniedPick": "La destination d enregistrement n a pas ete acceptee. Choisissez un autre fichier pour continuer.",
  "desktop.output.deniedFallback": "La destination d enregistrement a ete refusee.",
  "desktop.proto.incompatible":
    "Cette version de l application ne peut pas ouvrir cette image depuis {host}. Mettez l application a jour et reessayez.",
  "desktop.handoff.rejected":
    "Ce lien ne peut pas etre ouvert depuis {host}. Essayez une autre adresse sans donnees de connexion.",
  "desktop.handoff.acceptedDetail":
    "Cette image peut etre confiee a une autre application. Vous etes deja dans l application native, vous pouvez donc continuer ici.",
  "desktop.handoff.rejectedDetail":
    "Cette image ne peut pas etre confiee a une autre application. Continuez ici ou essayez une autre image.",
  "desktop.output.exists":
    "Un fichier existe deja a la destination d enregistrement depuis {host}. Choisissez un autre fichier ou confirmez l ecrasement pour continuer.",
  "desktop.output.destDenied":
    "La destination d enregistrement n a pas ete acceptee depuis {host}. Choisissez un autre fichier pour continuer.",
  "desktop.job.gone": "Cette tache n est plus active depuis {host}. Recommencez avec une adresse recente.",
  "desktop.msg.thisPicture": "cette image",
  "desktop.msg.dimsPixels": "{a} par {b} pixels",
  "desktop.msg.needAbout": " Elle a besoin d environ {need} de memoire",
  "desktop.output.canvasLimit":
    "Cette image est trop grande pour etre assemblee sur cet ordinateur ({dims},{need} a 4 octets par pixel, limite {limit}). Enregistrez une version plus petite avec Largeur max (CLI : --max-width). Note : le JPEG accepte au plus {jpegMax} pixels par cote ; gardez le PNG pour les images plus grandes. Depuis {host}.",
  "desktop.output.jpegLimit":
    "Cette image ({dims}) est trop grande pour le JPEG, qui accepte au plus {jpegMax} pixels par cote. Enregistrez-la en PNG a la place. Depuis {host}.",
  "desktop.tile.partialDiscarded":
    "L image partielle a ete abandonnee, aucun fichier n a ete conserve. Reessayez depuis {host} avec une connexion stable.",
  "desktop.tile.partialChoice":
    "Certaines parties de cette image depuis {host} n ont pas pu etre enregistrees. Reessayez les parties manquees, ou conservez l image partielle avec des zones vides.",
  "desktop.discovery.none":
    "Aucune image zoomable trouvee a cette adresse depuis {host}. Essayez une autre page ou verifiez l adresse.",
  "desktop.plan.none":
    "Cette image n a aucune taille utilisable a enregistrer depuis {host}. Essayez une autre image ou une Largeur max plus petite.",
  "desktop.transport.stalled": "Enregistrement bloque lors du contact avec {host}. Verifiez votre connexion et reessayez.",
  "desktop.output.writeFail":
    "Impossible d ecrire cette image depuis {host}. Choisissez une autre destination et reessayez.",
  "desktop.job.cancelledMsg": "L enregistrement de l image a ete interrompu. Tout fichier inacheve a ete supprime.",
  "desktop.start.failed": "Impossible de demarrer l enregistrement de cette image depuis {host}. Reessayez.",
  "desktop.choice.failed": "Ce choix n a pas ete accepte. Reessayez.",
  "desktop.save.generic": "Impossible d enregistrer cette image depuis {host}. Reessayez avec une autre adresse.",
  "desktop.internal.error":
    "Un probleme inattendu a interrompu cet enregistrement depuis {host}. Reessayez, et copiez les diagnostics si cela se reproduit.",
  "desktop.save.fallback": "Impossible d enregistrer cette image depuis {host}. Reessayez.",
  "desktop.job.failedFallback": "La tache a echoue.",
  "desktop.invoke.startFallback": "Impossible de demarrer la tache.",
  "desktop.invoke.choiceImage": "Le choix de l image a ete refuse.",
  "desktop.invoke.choiceLevel": "Le choix de la resolution a ete refuse.",
  "desktop.invoke.retry": "La demande de nouvel essai a ete refusee.",
  "desktop.invoke.partial": "Le choix d image partielle a ete refuse.",
  "desktop.invoke.destination": "Impossible de demander la destination d enregistrement.",
  "desktop.step.chooseWhere": "Choisissez ou enregistrer…",
  "desktop.step.chooseWhereDetail": "La destination d enregistrement demande votre attention avant de continuer.",
  "desktop.step.pickOutput": "Choisissez le fichier de sortie pour continuer.",
  "desktop.step.partialTitle": "Certaines tuiles n ont pas pu etre enregistrees…",
  "desktop.step.partialDetail": "Choisissez de conserver l image partielle, de l abandonner ou de reessayer.",
  "desktop.step.displayPreview": "Apercu seul…",
  "desktop.step.displayDetail": "Cette image peut seulement etre vue ici.",
  "desktop.step.cleanupDetail": "Nettoyage… suppression du fichier inacheve…",
  "desktop.step.cleaningShort": "Nettoyage…",
  "desktop.step.encodingNative": "Encodage dans l application native",
  "desktop.step.encodingPartial": "Encodage de l image partielle dans l application native",
  "desktop.step.discardingPartial": "Abandon de l image partielle",
  "desktop.step.retrying": "Nouvel essai",
  "desktop.step.appAutoDetail": "L application enregistre automatiquement la premiere image ; aucun selecteur n est propose.",
  "desktop.step.foundFits": "{noun} trouvee, enregistrement de la plus grande possible…",
  "desktop.step.tilesAtFull": "{current} tuiles sur {total} en pleine resolution",
  "desktop.step.savedDims": "{width} par {height} pixels enregistres",
  "desktop.step.partialDims": "Image partielle {width} par {height} pixels ; {summary}",
  "desktop.step.partialSaved": "Image partielle enregistree ; {summary}",
  "desktop.step.savedWord": "Enregistre",
  "desktop.step.contacting": "Contact avec {host}…",
  "desktop.link.title": "Une autre application veut ouvrir une image dans Dezoomify.",
  "desktop.link.source": "Source : {url}",
  "desktop.link.prov": "Provenance : lien dezoomify:// (v{version})",
  "desktop.link.provHint": "Provenance : lien dezoomify:// (v{version}) · {hint}",
  "desktop.link.note": "Rien ne s execute avant votre confirmation. Refuser ne fait rien.",
  "desktop.link.dismiss": "Ignorer",
  "desktop.link.open": "Ouvrir l image",
  "desktop.rec.partialTitle": "Certaines tuiles n ont pas pu etre enregistrees",
  "desktop.rec.partialDesc":
    "Une partie de l image manque. {summary} Conservez l image partielle (les zones vides restent vides), abandonnez-la ou reessayez les tuiles manquees.",
  "desktop.rec.missing": "Tuiles manquantes : {shown}{rest}.",
  "desktop.rec.more": " et {n} de plus",
  "desktop.rec.destTitle": "La destination d enregistrement demande votre attention",
  "desktop.rec.destDesc":
    "La destination d enregistrement n a pas ete acceptee. Choisissez un fichier de sortie, reessayez ou utilisez une autre application.",
  "desktop.rec.chooseTitle": "Choisissez ou enregistrer",
  "desktop.rec.chooseDesc": "Choisissez le fichier de sortie pour continuer l enregistrement de cette image.",
  "desktop.rec.keep": "Conserver l image partielle",
  "desktop.rec.discard": "Abandonner la partie",
  "desktop.rec.retryTiles": "Reessayer les tuiles manquees",
  "desktop.rec.chooseOutput": "Choisir la sortie…",
  "desktop.rec.tryAgain": "Reessayer",
  "desktop.rec.useOther": "Utiliser une autre application",
  "desktop.rec.missingSome": "Certaines tuiles n ont pas pu etre enregistrees.",
  "desktop.rec.missingCount": "{count} tuile{plural} n ont pas pu etre enregistrees.",
  "desktop.rec.missingList": "{n} tuile{plural} manquante(s) : {shown}{rest}.",
  "desktop.done.partialTitle": "Image partielle enregistree",
  "desktop.done.partialDesc":
    "Ce fichier est marque comme partiel : {summary} Les zones manquantes restent vides. Cela le distingue d un enregistrement complet.",
  "desktop.cancel.note": "Enregistrement annule. Le nettoyage est termine et tout fichier inacheve a ete supprime.",
  "desktop.copy.diagnostics": "Copier les diagnostics",
  "desktop.copy.copied": "Copie !",
  // Multi-job queue panel (desktop integration queue, todo 5.3). Jobs save
  // one at a time in the order they were added; a failed job never stops the
  // rest. Only redacted origins appear here, never full addresses.
  "desktop.queue.title": "File d attente",
  "desktop.queue.statusQueued": "En attente",
  "desktop.queue.statusActive": "En cours",
  "desktop.queue.statusDone": "Termine",
  "desktop.queue.statusFailed": "Echoue",
  "desktop.queue.statusCancelled": "Annule",
  "desktop.queue.cancel": "Annuler",
  "desktop.queue.cancelAll": "Tout annuler",
  "desktop.queue.retry": "Reessayer",
  "desktop.queue.summary": "{succeeded} terminees, {failed} echouees, {total} au total",
  "desktop.queue.progress": "{current} tuiles sur {total}",
  "desktop.queue.unknownOrigin": "le serveur",
  "desktop.panel.outputFormat": "Format de sortie",
  "desktop.panel.jobActions": "Actions de la tache de bureau",
  "desktop.help.title": "Aide et a propos",
  "desktop.help.help": "Aide",
  "desktop.help.desktopGuide": "Guide du bureau",
  "desktop.help.troubleshooting": "Depannage",
  "desktop.help.faq": "FAQ",
  "desktop.help.privacy": "Confidentialite",
  "desktop.help.terms": "Conditions",
  "desktop.help.donate": "Faire un don",
  "desktop.settings.title": "Parametres",
  "desktop.settings.desc":
    "Parametres de telechargement minimaux. Enregistres sur cet appareil et utilises pour la prochaine tache. Les entetes sont envoyes uniquement a l origine de l image et ne sont jamais journalises.",
  "desktop.settings.outputDir": "Dossier de sortie (facultatif)",
  "desktop.settings.compression": "Compression 0-100 (defaut 5)",
  "desktop.settings.maxWidth": "Largeur max en px (facultatif)",
  "desktop.settings.maxHeight": "Hauteur max en px (facultatif)",
  "desktop.settings.retries": "Essais 0-100 (defaut 3, 0 = aucun)",
  "desktop.settings.cacheDir": "Dossier de cache (facultatif, reprise)",
  "desktop.settings.emptyLargest": "vide = la plus grande",
  "desktop.settings.browse": "Parcourir…",
  "desktop.settings.browseOutput": "Choisir le dossier de sortie",
  "desktop.settings.browseCache": "Choisir le dossier de cache",
  "desktop.settings.headersAdv": "Avance : entetes de requete (de confiance)",
  "desktop.settings.headersLabel": "Entetes de requete, un par ligne sous la forme Nom : valeur (facultatif, de confiance)",
  "desktop.settings.reset": "Reinitialiser les parametres",
  "desktop.settings.crop": "Recadrer x,y,w,h en pixels du niveau (facultatif)",
  "desktop.settings.cropPlaceholder": "p. ex. 100,100,800,600",
  // Crop / region selection (shared UI, website preview, desktop, extension).
  "view.crop.button": "Recadrer",
  "view.crop.hint": "Faites glisser sur l apercu pour choisir une zone, ou saisissez des nombres exacts.",
  "view.crop.x": "X",
  "view.crop.y": "Y",
  "view.crop.w": "Largeur",
  "view.crop.h": "Hauteur",
  "view.crop.apply": "Appliquer le recadrage",
  "view.crop.clear": "Effacer",
  "view.crop.size": "Zone : {size}",
  "view.crop.invalid": "Cette zone est vide ou hors de l image. Choisissez x,y,w,h dans la taille du niveau.",
  // Extension page user copy (apps/extension/src/page/page.ts). The page
  // imports this table through its vendored `page/vendor/i18n.js` codegen
  // mirror (see `scripts/sync-web-js.mjs`) and renders through the same
  // `t(key, vars)` shape; log and diagnostics lines stay literal English and
  // never use these keys. `test/ui-i18n.test.mjs` fails when the page renders
  // a key outside this table.
  "page.step.scanning": "Analyse de la page…",
  "page.step.finding": "Recherche de l image zoomable ({done}/{total})…",
  "page.step.choosing": "Choix de la plus haute resolution…",
  "page.step.saving": "Enregistrement des tuiles…",
  "page.step.assembling": "Assemblage de l image finale…",
  "page.step.done": "Termine",
  "page.step.cancelled": "Annule",
  "page.step.cancelling": "Annulation…",
  "page.step.displaying": "Affichage de l image…",
  "page.tabs.scan": "Analyser {label}",
  "page.tabs.hint":
    "Ouvrez une page avec une image zoomable, puis cliquez sur le bouton Dezoomify de la barre d outils pour analyser cet onglet.",
  "page.handoff.sendOrigin": "Envoyer vers l application de bureau ({origin})",
  "page.handoff.stay": "Rester dans l extension",
  "page.handoff.send": "Envoyer vers l application de bureau",
  "page.handoff.title": "Envoyer vers l application de bureau ?",
  "page.handoff.host": "Hote : {host}",
  "page.handoff.origins": "Origines : {list}",
  "page.handoff.originsNone": "Origines : (aucune)",
  "page.handoff.cookies": "Cookies : {list}",
  "page.handoff.cookiesNone": "Cookies : (aucun)",
  "page.handoff.job": "Tache : {id}",
  "page.handoff.note": "Rien n est envoye avant votre confirmation. Refuser garde la tache dans l extension.",
  "page.ui.techDetails": "Details techniques et journaux",
} as const;
