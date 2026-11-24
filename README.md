# U-Disa for Windows

Extract the whole folder. Install Node.js 24 LTS if needed. U-Disa uses the SQLite database built into Node. There are no packages to install.

**Moving existing books**  
Close the previous U-Disa app. Before starting a fresh copy, double-click **Import previous books.bat**. On Vinayak's PC it finds the previous Qoder project's database. On another PC, drag the old `data/udisa.db` onto the importer. The importer copies a consistent database snapshot and requires an empty destination. Continue entering transactions in the new copy.

**Opening the app**  
Double-click **Start U-Disa.bat**. Keep its window open. Running it again opens the existing instance. The console shows the actual local URL if the usual port is occupied.

**First use**  
Register with the Udyam number on the certificate. Registration checks its format locally. Existing owners can sign in with their mobile number or previously stored ID. Create a one-time password recovery key during registration or from Profile while signed in. Save it privately. A password reset consumes that key.

Add an item under Stock and enter its opening quantity and unit prices. Choose **Record a sale** on Home to post money and stock together. Choose credit and select or name the customer for udhaar. Record collections from Accounts. Use stock corrections for damage or a count adjustment.

**Connectivity**  
Sign in online first. Keep the signed-in tab open when the connection drops. Pending records stay in the same browser and business account. Open Profile to review entries, download them, or retry. Book totals reflect server-confirmed entries. Old pending records from v1 have no owner ID and are preserved for manual review.

**Backups and devices**  
For a full backup, stop U-Disa and copy its entire data folder to a private location. Restore a backup database into a fresh copy using the importer. Profile also exports business records as JSON and ledger rows as CSV. The Windows launcher serves this PC by default. A multi-device deployment needs an HTTPS host running the Node server with persistent SQLite storage.

The loan directory uses the supplied FY 2025–26 reference from page three onward. Check current availability with the lender. The directory links to myScheme for central and state benefits.
