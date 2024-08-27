extern crate reqwest;
extern crate tempfile;
extern crate zip;
extern crate clap;

use std::fs::{self, File};
use std::io::{self, copy};
use std::path::{Component, Path, PathBuf};
use std::io::{BufRead};
use std::env;


use clap::{Parser, Subcommand, Args};

#[derive(Parser)]
#[command(version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Args, Debug)]
struct FetchArgs 
{
    /// The user or organization
    user: String,
    /// The mission (repository) name
    mission: String,
    /// Optional: The folder
    mission_folder: Option<String>,
    /// Optional: branch
    #[arg(short, long, default_value="main")]
    branch: String,
    /// Optional: include documentation
    #[arg(short, long)]
    docs: bool,
}

#[derive(Args, Debug)]
struct FetchLibArgs 
{
    // The user or organization
    user: String,
    // The mission (repository) name
    repo: String,
    // The library name
    lib: String,
    // The library version
    version: String,
    // sbslib or mastlib
    libext: String,
    // Optional: The mission folder name
    mission_folder: String,
}



#[derive(Subcommand)]
enum Commands {
    /// fetch a mission
    Fetch(FetchArgs) 
}


fn fetch_sbs_lib(args: &FetchLibArgs, base_dir: &str, sub_folder: &Option<String>) {

    
    let lib = args.lib.clone();

    // "https://github.com/%USER%/%REPO%/releases/download/%VERSION%/%REPO%_%VERSION%.sbslib"
    let url = format!("https://github.com/{}/{}/releases/download/{}/{}_{}.{}" 
        , args.user
        , args.repo
        , args.version
        , lib
        , args.version
        , args.libext);

    let mission_folder = args.mission_folder.clone();
    let local = match sub_folder {
        Some(s) => 
            format!("{}/{}/{}/{}_{}.{}" 
                , base_dir
                , mission_folder
                , s
                , lib
                , args.version
                , args.libext),
        None => format!("{}/{}/{}_{}.{}" 
            , base_dir
            , mission_folder
            , lib
            , args.version
            , args.libext)
    };
        
    // Create the directory.
    fs::create_dir_all(&mission_folder).expect("creation mission folder failed"); 
    println!("Fetching sbs_lib  {} to {}", url.to_string(), local.to_string());
    let mut data_file = File::create(local).expect("creation failed");
    reqwest::blocking::get(url).unwrap().copy_to(&mut data_file);
    
}


fn fetch_mission_code(args: &FetchArgs, base_dir: &str) -> zip::result::ZipResult<()>{
    // Default branch to master
    let br = args.branch.clone(); //.unwrap_or("main".to_string());
    let mission_folder = args.mission_folder.clone().unwrap_or(args.mission.to_string());


    let mut tmpfile = tempfile::tempfile().unwrap();

    let url = format!("https://github.com/{}/{}/zipball/{}/", args.user, args.mission, br);
    //let url = format!("https://github.com/{}/{}/archive/refs/heads/{}.zip", args.user, args.mission, br);

    println!("Fetching archive {}", url.to_string());
    //return Ok(());

    reqwest::blocking::get(url).unwrap().copy_to(&mut tmpfile);
    let mut archive = zip::ZipArchive::new(tmpfile).unwrap();
    //list_zip_contents(archive);


    for i in 0..archive.len() {
        // Get the file at the current index.
        let mut file = archive.by_index(i)?;

        // Get the path to extract the file to.
        let f_outpath = match file.enclosed_name() {
            Some(path) => path.to_owned(),
            None => continue, // Skip to the next file if the path is None.
        };
        

        let mut comp = f_outpath.components();
        comp.next();
        let short_path = comp.as_path();

        let just_file = match short_path.file_name() {
            Some(c) => c.to_str().unwrap(),
            None => continue, // Skip to the next file if the path is None.
        };
        let parent = match short_path.parent()  {
            Some(path) => path,
            None => continue, // Skip to the next file if the path is None.
        };
        let just_dir = match parent.to_str() {
            Some(path) => path,
            None => continue, // Skip to the next file if the path is None.
        };
        //let just_dir = parent.file_name().unwrap().to_str().unwrap();

        if just_file.starts_with('.') || just_dir.starts_with('.'){
            println!("skip {}", just_file);
            continue
        }
        if just_dir.starts_with("mkdocs") && !args.docs{ 
            println!("skip mkdocs");
            continue
        }
        

        let mut outpath = PathBuf::from(base_dir);
        outpath.push(mission_folder.to_string());
        outpath.push(short_path);


        // Get the comment associated with the file.
        let comment = file.comment();
        if !comment.is_empty() {
            println!("File {} comment: {}", i, comment); // Print the file comment if it's not empty.
        }

        // Check if the file is a directory.
        if file.name().ends_with('/') {
            print!("\rFile {} extracted to \"{}\"", i, outpath.display()); // Print a message indicating the directory extraction.
            fs::create_dir_all(&outpath)?; // Create the directory.
        } else {
            println!(
                "File {} extracted to \"{}\" ({} bytes)",
                i,
                outpath.display(),
                file.size()
            ); // Print a message indicating the file extraction and its size.

            // Create parent directories if they don't exist.
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(&p)?;
                }
            }

            // Create and copy the file contents to the output path.
            let mut outfile = File::create(&outpath)?;
            copy(&mut file, &mut outfile)?;
        }
    }
    println!("Done");
    Ok(())
    
}


// The output is wrapped in a Result to allow matching on errors.
// Returns an Iterator to the Reader of the lines of the file.
fn read_lines<P>(filename: P) -> io::Result<io::Lines<io::BufReader<File>>>
where P: AsRef<Path>, {
    let file = File::open(filename)?;
    Ok(io::BufReader::new(file).lines())
}

fn fetch_mission_deps(args: &FetchArgs, lib_type: &str, base_dir: &str, sub_folder: &Option<String>){
    // read deps file
    let mission_folder = args.mission_folder.clone().unwrap_or(args.mission.to_string());
    let local = format!("{}.txt", lib_type); 


    let mut deps_file = PathBuf::from(base_dir.to_string());
        deps_file.push(mission_folder.to_string());
        deps_file.push(local);

    if !deps_file.exists() {
        return
    }

    if let Ok(lines) = read_lines(deps_file) {
        // Consumes the iterator, returns an (Optional) String
        for line in lines.flatten() {
            println!("{}", line);
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 3 {
                continue
            }

            let user = parts[0];
            let repo = parts[1];
            let version = parts[2];
            let lib = if parts.len() >3 {
                parts[3]
            } else {
                parts[1]
            };
            let args = FetchLibArgs{
                user: user.to_string(),
                repo: repo.to_string(),
                lib : lib.to_string(),
                version: version.to_string(),
                libext: lib_type.to_string(),
                mission_folder: mission_folder.clone()
            };
            fetch_sbs_lib(&args, base_dir, sub_folder);
        }
    }
    // read line
    // split on whitespace

    // USER        REPO      VERSION   [LIBNAME]
    // artemis-sbs sbs_utils v3.9.30b
    // artemis-sbs LegendaryMissions v3.9.30b zadmiral
    
  
}

fn fetch_mission_sbs_deps(args: &FetchArgs, base_dir: &str){
    fetch_mission_deps(args, "sbslib", base_dir, &None);
}

fn fetch_mission_mast_deps(args: &FetchArgs, base_dir: &str){
    fetch_mission_deps(args, "mastlib", base_dir, &Some(String::from("addons")));
}

fn fetch_mission(args: &FetchArgs, base_dir: &str) -> zip::result::ZipResult<()>{
    if fetch_mission_code(args, base_dir).is_ok(){
        fetch_mission_sbs_deps(args, base_dir);
        fetch_mission_mast_deps(args, base_dir);
    }
    Ok(())
}

fn main() {
    let base_dir = match env::current_exe() {
        Ok(exe_path) => exe_path.parent().unwrap().display().to_string(),
        Err(e) => {
            println!("failed to get current exe path: {e}"); 
            return;
        },
    };
    let cli = Cli::parse();

    // You can check for the existence of subcommands, and if found use their
    // matches just as you would the top level cmd
    match &cli.command {
        Some(Commands::Fetch(fetch_args)) => {
            let _ = fetch_mission(&fetch_args, &base_dir);        
        }
        None => {}
    }
    
    // let args = FetchArgs{
    //     user: "artemis-sbs".to_string(),
    //     mission: "LegendaryMissions".to_string(),
    //     mission_folder: None,
    //     branch: None,
    //     docs: Some(false),
    //     base_dir: base_dir.to_string(),    
    // };
    

    //fetch_sbs_lib(&args);
}

    
//     let cli = Cli::parse();

//     // You can check for the existence of subcommands, and if found use their
//     // matches just as you would the top level cmd
//     match &cli.command {
//         Some(Commands::Fetch(fetch_args)) => {
//             let _ = fetch_mission(fetch_args);        
//         }
//         None => {}
//     }
    
// }