package app.murmur.android.text

/**
 * Port of packages/text-engine/src/common-words.ts: frequent English words that are not names,
 * places, months or days. A word here is written in lower case when a stray sentence end before it
 * is removed (PauseStops.kt); any other word keeps its capital.
 */
val COMMON_WORDS: Set<String> = (
    "ability able about above absolute absolutely abuse academic academy accept accepted access " +
    "accident according account accounts accurate achieve achieved across act acting action " +
    "actions active activities activity actor acts actual actually ad add added adding addition " +
    "additional address administration admit admitted adopted adult adults advance advanced " +
    "advantage advertising advice affairs affect affected afford afraid after afternoon again " +
    "against age aged agencies agency agent agents ages ago agree agreed agreement ahead aid " +
    "aim air aircraft airport album alcohol alive all allow allowed allowing allows almost " +
    "alone along already also alternative although always am amazing americans among amount " +
    "analysis ancient and angry animal animals anniversary announced annual another answer " +
    "answers anti any anybody anymore anyone anything anyway anywhere apart apartment app " +
    "apparently appeal appear appearance appeared appears apple application applications " +
    "applied apply appointed appointment appreciate approach appropriate approval approved " +
    "approximately are area areas argument arm armed arms army around arrest arrested arrived " +
    "article articles artist artists arts as aside ask asked asking aspects ass assembly assets " +
    "assistance assistant associated association assume at attached attack attacked attacks " +
    "attempt attempts attend attended attention attitude attorney attractive audience audio " +
    "author authorities authority authors auto automatically available average avoid award " +
    "awards aware away awesome baby back background bad bag balance balls ban band bank bar " +
    "barely base baseball based basic basically basis basketball bathroom battery bay be bear " +
    "beat beautiful beauty became because become becomes becoming bed been beer before began " +
    "begin beginning begins behavior behind being believe believed below benefit benefits " +
    "besides bet better between beyond big bigger biggest bike billion bills birds birth " +
    "birthday bit bitch blame blind blog blood blow board boat bodies body bomb book books " +
    "border born boss both bottle bottom bought bowl boy boyfriend boys bread break breakfast " +
    "breaking breath bridge brief brilliant bring bringing brings broad broke broken brother " +
    "brought budget build building buildings built bullshit burn burning bus business " +
    "businesses busy but button buy buying by cabinet cable cake called calling calls calm came " +
    "camera campaign campus can cancer candidate candidates cannot cap capable capacity capital " +
    "captain car carbon card cards care career careful carried carrying cars cases cast cat " +
    "catch category caught cause caused causes causing celebrate cell cells cent center central " +
    "centre century certain certainly chain chair chairman challenge challenges chamber " +
    "champions championship chances change changed changes changing channel chapter character " +
    "characters charge charged charges chart chat cheap check checked cheese chemical chest " +
    "chicken chief child childhood children chocolate choice choose chose chosen circle circuit " +
    "circumstances cities citizens city civil claim claimed claims class classes classic clean " +
    "clear clearly click client climate clinical close closed closely closer clothes clothing " +
    "club clubs coach coal coast code coffee cold collected collection college color colour " +
    "combat combination combined come comedy comes comfortable coming command commander comment " +
    "comments commercial commission committed committee common communication communications " +
    "communities community companies company compared comparison competition competitive " +
    "complete completed completely complex complicated computer concept concern concerned " +
    "concerns concert condition conditions conduct conducted conference confidence confirmed " +
    "conflict confused connected connection consequences conservative consider considered " +
    "considering consistent constant constantly constitution construction consumer contact " +
    "contain contains contemporary content contest context continue continued continues " +
    "continuing contract control controlled convention conversation cool copy core corner " +
    "corporate corporation correct cost costs could council count counter countries country " +
    "county couple course court cover coverage covered covers crash crazy cream create created " +
    "creating creation creative credit crew crime criminal crisis critical criticism crowd " +
    "crown cry crying cultural culture cup current currently customer customers cut cute " +
    "cutting cycle dad daily damage damn dance dancing danger dangerous dark data date dates " +
    "dating daughter days dead dealing deals dear death deaths debate debt debut decade decades " +
    "decide decided decision decisions declared dedicated deep defeat defence defend defense " +
    "defined definitely definition degree degrees deliver delivered delivery demand democracy " +
    "department depending depends depression depth deputy describe described description " +
    "deserve design designed despite destroy destroyed detail detailed details determine " +
    "determined develop developed developing development device devices did die died diet " +
    "difference differences different difficult digital dinner direct directed direction " +
    "directly director dirty discovered discuss discussion disease display distance " +
    "distribution district divided division dna doctor doctors document documents does dog dogs " +
    "doing dollar dollars domestic done door doors double doubt down download draft drama draw " +
    "drawing drawn dream dreams dress drink drinking drive driven drivers driving drop dropped " +
    "drug drugs drunk dry dude due dumb during duty dying each earlier earn earned earth easier " +
    "easily eastern easy eat eating economic economy edge edition editor education educational " +
    "effect effective effectively effects effort efforts eggs eight either elected election " +
    "elections electric electronic elements email emergency emotional empire employee employees " +
    "employment empty end ended ending ends enemy energy engaged engine engineer engineering " +
    "enjoy enjoyed enough ensure enter entered entertainment entire entirely entitled entry " +
    "environment environmental episode equal equipment equivalent error escape especially " +
    "essential established estate estimated etc even evening event events eventually ever every " +
    "everybody everyday everyone everything everywhere evidence evil ex exact exactly example " +
    "examples excellent except exchange excited exciting exclusive excuse executive exercise " +
    "exist existence existing exists expansion expect expected expensive experience experienced " +
    "experiences expert experts explain explained exposed express expressed expression extended " +
    "extensive extent external extra extreme extremely eye eyes face faced faces facilities " +
    "facility facing fact factor factors factory facts fail failed failure fairly fake fall " +
    "falling falls false familiar families family famous fan fans fantastic fantasy far farm " +
    "fashion fast faster fat father fault favor favorite favourite fear feature features fed " +
    "federal fee feed feel feeling feelings feels fees feet fell fellow felt female festival " +
    "few fifth fight fighting figure figures file filed fill filled film films final finally " +
    "finance financial find finding finds fine finger fingers finish finished fire fired firm " +
    "first fishing fit five fix fixed flag flat flight floor flow fly flying focus focused " +
    "folks follow followed following follows food foot football for force forced forces foreign " +
    "forever forget forgot form format formation formed former forms forward fought found " +
    "foundation founded four fourth frame freedom frequently fresh friendly friends from front " +
    "fruit fuck fucked fucking fuel full fully fun function functions fund funding funds funny " +
    "further future gain gained gallery game games gang gap garden gas gate gave gender general " +
    "generally generation get gets getting giant gift girl girlfriend girls give given gives " +
    "giving glad global go goal goals goes going golf gone gonna goods got gotta gotten " +
    "government governor grab grade graduate grand granted great greater greatest grew ground " +
    "group groups grow growing grown growth guard guess guest guide guilty guitar gun guns guys " +
    "had hair half handle hands hanging happen happened happening happens happy hard hardly " +
    "harm has hat hate have having he headed heading heads health healthcare healthy hear " +
    "hearing heart heat heaven heavily heavy height held hell hello help helped helping helps " +
    "her here hero herself hidden hide higher highest highly highway him himself his historic " +
    "historical history hit hits hold holding holds hole holiday holy home homes honest " +
    "honestly honor hopefully hoping horse hospital host hot hotel hour hours household houses " +
    "housing how however huge human humans hundred hundreds husband ice idea ideas identified " +
    "identify identity if ignore ill illegal image images imagine immediate immediately " +
    "immigration impact importance important impossible impressive improve improved improvement " +
    "inch incident include included includes including income increase increased increasing " +
    "incredible indeed independence independent index individual individuals industrial " +
    "industry influence info information initial initially injured injury inner inside inspired " +
    "instance instead institute institutions insurance intelligence intended interest " +
    "interested interesting interests interior internal international internet interview into " +
    "introduced introduction investigation investment invited involved involving iron is island " +
    "islands issue issued issues it item items its itself jail job jobs join joined joining " +
    "joint joke journal journey judge jump jury just keep keeping keeps kept kick kid kids kill " +
    "killed killer killing kind kinda kinds kingdom kiss knew know knowing knowledge known " +
    "knows labor labour lack ladies laid language large largely larger largest last late later " +
    "latest latter laugh laughing launch launched lawyer lead leader leaders leadership leading " +
    "leads league learn learned learning least leave leaves leaving led left leg legal " +
    "legislation legs length less lesson let lets letter letters letting level levels liberal " +
    "library license lie lies life lift lights like liked likely likes limit limited limits " +
    "line lines linked links list listed listen listening literally literature live lived lives " +
    "living load loans local located location lock longer look looked looking looks lose losing " +
    "loss lost lot lots loud loved lovely loves loving low lower luck lucky lunch lying machine " +
    "mad made magazine magic mail mainly maintain maintenance majority make makes making male " +
    "manage managed management manager managers manner manufacturing map marked market " +
    "marketing markets marriage married mass massive master match matches mate material " +
    "materials matter matters maximum maybe mayor me meal mean meaning meant meanwhile measure " +
    "measures meat media medical medicine medium meet meeting meetings member members " +
    "membership memories memory men mental mention mentioned mess message messages met metal " +
    "method methods miami mid middle might mile military milk million millions mind mine " +
    "minimum mining minister ministry minute minutes mirror missed missing mission mistake mix " +
    "mixed mobile mode model models modern mom moment moments money monster month monthly " +
    "months more morning most mostly mother motion motor mount mountain mountains mouth move " +
    "moved movement moves movie movies moving much multi multiple murder museum music musical " +
    "must myself name named names nation national nations native natural naturally nature navy " +
    "near nearby nearly necessarily necessary neck need needed needs negative neighborhood " +
    "neither net network never new news newspaper next nice night nights nine no nobody noise " +
    "non none nor normal normally northern nose not note noted notes nothing notice noticed " +
    "novel now nuclear number numerous object objects obtained obvious obviously occur occurred " +
    "ocean of off offer offered offering offers office officer officers offices official " +
    "officially officials often oil okay old older on once one ones online only onto open " +
    "opened opening operate operating operation operations opinion opportunities opportunity " +
    "opposed opposite opposition option options or orange order ordered orders organization " +
    "organizations organized origin original originally other others otherwise our ourselves " +
    "out outside outstanding over overall own owned owner owners pacific pages paid pain paint " +
    "painting pair panel pants paper papers parents parking part particular particularly " +
    "parties partner partners partnership parts party pass passed passing past path patient " +
    "patients pattern pay paying payment payments peace peak people per percent percentage " +
    "perfect perfectly perform performance performed performing perhaps period permanent " +
    "permission personal personality personally personnel perspective phase philosophy phone " +
    "photo photos physical pick picked picture pictures piece pieces pilot pink place placed " +
    "places plan plane planet planned planning plans plant plants plastic plate platform play " +
    "played player players playing plays please pleasure plenty plot plus pocket point points " +
    "police policies policy political politicians politics poor pop popular population porn " +
    "port portion position positions positive possibility possible possibly posted posts " +
    "potential pounds powerful practical practice practices pre prefer pregnant premier prepare " +
    "prepared presence present presented president presidential press pressure pretty prevent " +
    "previous previously prices pride primarily primary prime principal print prior prison " +
    "private prize pro probably problem problems process produce produced product production " +
    "products professional professor profile profit program programme programs progress project " +
    "projects promise promised promote proof proper properly properties property proposal " +
    "proposed protect protected protection protein proud prove proved provide provided provides " +
    "providing province public published pull pulled purchase purchased pure purpose purposes " +
    "push put puts putting quality quarter question questions quickly quiet quit quite quote " +
    "race racing radio rain raise raised ran random range rape rare rate rates rather raw reach " +
    "reached reaction reading ready real reality realize realized really reason reasonable " +
    "reasons receive received receiving recent recently recognition recognize recognized " +
    "recommend recommended record recorded recording records recovery red reduce reduced " +
    "reference referred reform refused regarding regardless region regional regions register " +
    "registered regular regularly regulations related relations relationship relationships " +
    "relative relatively release released relevant relief religion religious remain remained " +
    "remaining remains remember remove removed rent repeat replace replaced reply report " +
    "reported reporting reports represent representative representatives represented represents " +
    "republic reputation request require required requirements requires rescue research reserve " +
    "residents resistance resolution resources respect respond response responsibility " +
    "responsible rest restaurant result resulting results retail retirement return returned " +
    "returning returns revealed revenue review reviews revolution rid ride riding right rights " +
    "rise rising risk river road roads role roll rolling roof room rooms rough round route row " +
    "rule rules run running runs rural sad safe safety said sale sales salt same sat save saved " +
    "saving saw say saying says scale scared scene scenes schedule scheme school schools " +
    "science scientific scientists score scored screen sea search seasons seat seats second " +
    "secondary seconds secret secretary section sector secure security seeing seek seeking seem " +
    "seemed seems seen sees selected selection sell selling semi senator send sending senior " +
    "sense sent sentence separate series serious seriously serve served service services " +
    "serving session sessions set sets setting settlement seven several severe sex sexual shall " +
    "shame shape share shared shares sharing she shift ship shipping ships shirt shit shoes " +
    "shoot shooting shop shopping shortly shot shots should shoulder show showed shower showing " +
    "shown shows shut sick side sides sight sign signal signed significant significantly signs " +
    "similar simple simply since sing singing single sir sister sit site sites sitting " +
    "situation situations six size skills skin sky sleep sleeping slightly slow slowly smaller " +
    "smell smile smoke smoking soccer social society soft software solar sold soldiers solid " +
    "solo solution solutions some somebody somehow someone something sometimes somewhat " +
    "somewhere songs sons sorry sort sought soul sound sounds source sources southern space " +
    "speak speaker speaking special species specific specifically speech speed spend spending " +
    "spent spirit split spoke sport sports spot spread squad square stable stadium staff stage " +
    "stand standard standards standing stands stars start started starting starts state stated " +
    "statement statements states station stations statistics status stay stayed staying steam " +
    "steel step steps stick stock stood stop stopped storage store stores stories storm " +
    "straight strategy stream streets strength stress strike stronger strongly structure " +
    "structures struggle stuck student students studied studies studio study stuff stupid style " +
    "sub subject success successful such suddenly suffered suffering sugar suggest suggested " +
    "suggests suicide suit super supplies supply support supported supporting suppose supposed " +
    "supreme sure surely surface surgery surprise surprised surrounding survey survive suspect " +
    "swear switch symptoms system systems table take taken takes taking talent talk talked " +
    "talking talks tall tank target task taste taught tax taxes tea teach teacher teachers " +
    "teaching team teams tears tech technical technique techniques technology teeth television " +
    "tell telling tells temperature temporary ten tend term terms terrible territory test " +
    "tested testing tests text than thank thanks that the theatre their them theme themselves " +
    "then theory therapy there therefore these they thin thing things think thinking thinks " +
    "third this those though thought thoughts thousand thousands threat three through " +
    "throughout throw thus ticket tickets tie tight till time times tip tips tired title to " +
    "today together told tomorrow tone tonight too took tool tools top topic total totally " +
    "touch tough tour tournament toward towards tower town track trade trading tradition " +
    "traditional traffic train trained training transfer transport transportation travel treat " +
    "treated treatment tree trees trend trial trick tried tries trip troops trouble truck true " +
    "truly trust truth try trying turn turned turning turns twenty twice two type types typical " +
    "typically ultimate ultimately unable under understand understanding understood " +
    "unfortunately union unique unit united units universal universe university unknown unless " +
    "unlike until up update updated upon upper upset us use used useful user users uses using " +
    "usual usually valley valuable value values variety various vast vehicle vehicles version " +
    "very via vice victim victims victory video videos view views village violence vision visit " +
    "visited visitors visual voice volume vote voted votes voting wait waiting wake walk walked " +
    "walking wanna want wanted wanting wants war warm warning wars was waste watch watched " +
    "watching water wave ways we weak wealth weapon weapons wear wearing weather web website " +
    "wedding week weekend weekly weight weird welcome well went were western wet what whatever " +
    "wheel when whenever where whether which while who whole whom whose why wide widely wife " +
    "wild willing win wind window windows wine winner winning wins wish with within without " +
    "witness woman women won wonder wonderful wondering word words work worked workers working " +
    "works world worldwide worried worry worse worst worth would wow write writer writers " +
    "writing written wrong wrote yard yards yeah year years yellow yes yesterday yet you your " +
    "yours yourself youth zero zone "
).trim().split(" ").toSet()
