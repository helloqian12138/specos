App: User Manager

Goal:
  Manage active users with search, create, and disable flows.

---

Entity User:
  id: string (primary)
  name: string (required, maxLength=100)
  age: number (min=0,max=150)
  city: string
  sex: string (enum=Male|Female)
  active: boolean (default=true)

---

Action CreateUser:
  Input:
    name,age,sex,city
  Do:
    insert User:
      name = input.name
      age = input.age
      sex = input.sex
      city = input.city
      active = true
  Return:
    success
    id

---

Action SearchUsers:
  Input:
    searchKey = "" (optional)
    page
    pageSize
  Do:
    query User:
      where active = true
      and name contains searchKey
    paginate by page, pageSize
  Return:
    data: User[]
    total
  onError:
    message: User search failed

---

Action DisableUser:
  Input:
    id
  Do:
    update User:
      where id = input.id
      set active = false
  Return:
    success

---

Page UsersPage (/users):
  Summary:
    List active users, search them, and create new ones.

  Query:
    searchKey = ""
    page = 1
    pageSize = 10

  Header:
    text("User Manager", align=center)
    button("Add User", primary):
      onClick:
        openModal CreateUserModal

  Load:
    users = SearchUsers(searchKey, page, pageSize)

  Filters:
    input(searchKey)
    button("Search"):
      onClick:
        dispatch SearchUsers
        refresh users

  Content:
    table(users):
      columns:
        id
        name
        age
        city
        sex
        action:
          button("Disable"):
            onClick:
              dispatch DisableUser(id = row.id)
              refresh users

  Empty:
    text("No users found", align=center)

---

Component CreateUserModal:
  modal("Create User"):
    form:
      field name (input, required)
      field age (input-number)
      field sex (radio, [Male, Female])
      field city (input)

    onSubmit:
      dispatch CreateUser(name,age,sex,city)
      closeModal
      refresh users

---

State:
  users:
    source: SearchUsers
    autoLoad: true
    page = 1
    pageSize = 10
