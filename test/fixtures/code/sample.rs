use std::collections::HashMap;
use std::fs::{self, File};
use crate::util::log;
use std::io::{prelude::*, Result as IoResult};
pub use models::Role;
mod models;

pub struct User {
    pub name: String,
    age: u32,
}

pub trait Greeter {
    fn greet(&self) -> String;
}

impl Greeter for User {
    fn greet(&self) -> String {
        format!("hi {}", self.name)
    }
}

impl User {
    pub fn new(name: &str, age: u32) -> Self {
        User { name: name.to_string(), age }
    }

    pub fn rename(&mut self, name: &str) {
        self.name = name.to_string();
    }
}

pub enum Mode { A, B(u32) }

pub fn load_users(path: &str, limit: usize) -> Result<Vec<User>, String> {
    let data = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    if data.is_empty() {
        return Err("empty".into());
    } else if data.len() > 1000 {
        return Ok(vec![]);
    }
    for (i, line) in data.lines().enumerate() {
        if line.starts_with('#') {
            continue;
        }
        let user = User::new(line, i as u32);
        result.push(user);
        if result.len() >= limit {
            break;
        }
    }
    let mut n = 0;
    while n < 3 {
        n += 1;
    }
    loop {
        n -= 1;
        if n == 0 { break; }
    }
    match result.len() {
        0 => log("none"),
        1 | 2 => log("few"),
        _ => {
            log("many");
        }
    }
    let total = if n > 0 { n } else { 0 };
    Ok(result)
}

pub const MAX_USERS: usize = 100;
static mut COUNTER: u32 = 0;
pub type UserMap = HashMap<String, User>;

#[macro_export]
macro_rules! square {
    ($x:expr) => { $x * $x };
}

pub mod admin {
    /// Grants access to adults.
    pub fn grant(user: &super::User) -> bool {
        user.age >= 18
    }
}

fn describe(user: &User, n: usize) -> String {
    format!("{} #{}", user.name, n)
}

/// Finds the first adult that is not banned.
#[must_use]
pub(crate) async fn find_adult(users: &[User], banned: &[&str]) -> Option<String> {
    let mut checked = 0;
    'outer: for user in users {
        for name in banned {
            if user.name == *name {
                continue 'outer;
            }
        }
        checked += 1;
        if user.age >= 18 {
            break 'outer;
        }
    }
    let Some(first) = users.first() else {
        return None;
    };
    let label = describe(first, checked);
    match first.age {
        0 => None,
        a if a > 100 => Some(label),
        _ => {
            let shout = |s: &str| s.to_uppercase();
            Some(shout(&first.name))
        }
    }
}

fn drain(stack: &mut Vec<u32>) -> u32 {
    let mut sum = 0;
    while let Some(top) = stack.pop() {
        if top == 0 {
            panic!("zero");
        }
        sum += top;
    }
    if let Some(first) = stack.first() { sum + first } else { sum }
}
